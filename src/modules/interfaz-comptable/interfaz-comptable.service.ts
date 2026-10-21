// src/modules/interfaz-comptable/interfaz-comptable.service.ts
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  LoteComptable,
  LoteComptableDocument,
} from '../../database/schemas/contabilidad/lote-comptable.schema';
import {
  ConsecutivoLoteComptable,
  ConsecutivoLoteComptableDocument,
} from '../../database/schemas/contabilidad/consecutivo-lote-comptable.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  ResolucionDocumentosService,
  tipoDocumentoDe,
  type TipoDocumentoExport,
} from '../adicion-contabilidad/resolucion-documentos.service';
import {
  ComptableClient,
  type ResultadoComptable,
  type ResumenLoteComptable,
} from './comptable.client';
import {
  codigosTercero,
  construirPayloadComptable,
  inmueblesSinTitular,
  totalesDe,
  type OrigenPayload,
  type TitularesPorInmueble,
} from './payload-comptable';
import { toLoteComptable } from './interfaz-comptable.mapper';
import type {
  ConteoDocumentoComptable,
  EstadoInterfazComptable,
  LoteComptable as LoteComptableContract,
  PayloadComptable,
  PendientesComptable,
  ResultadoEnvioComptable,
  ResultadoSimulacionComptable,
} from '../../contracts';

/** Who is acting, for the lote, the payload and the audit log. */
export type ActorComptable = { accountId: string; nombre: string };

/** Machine codes of this module's own 409s, so the screen can tell them apart
 *  without parsing sentences. */
export type CodigoConflictoComptable =
  | 'NO_CONFIGURADO'
  | 'SIN_EMPRESA'
  | 'LOTE_PENDIENTE'
  | 'SIN_MOVIMIENTOS'
  | 'INMUEBLES_SIN_TITULAR'
  | 'LOTE_INTERVENIDO';

const ORDEN_DOCUMENTOS: TipoDocumentoExport[] = [
  'FV',
  'RC',
  'NC',
  'ND',
  'NT',
  'NA',
];

const MENSAJE_FIRMA =
  'Comptable rechazó la firma de WebSACO Finanzas: revisa COMPTABLE_HMAC_SECRET (debe ser el mismo en los dos sistemas) y que la hora del servidor esté bien.';

const conflicto = (
  codigo: CodigoConflictoComptable,
  message: string,
  extra: Record<string, unknown> = {},
): ConflictException =>
  new ConflictException({ statusCode: 409, codigo, message, ...extra });

const plural = (n: number, uno: string, varios: string): string =>
  `${n} ${n === 1 ? uno : varios}`;

/** Pesos from integer cents, for storage and the API. */
const aPesos = (centavos: number): number => centavos / 100;

/**
 * "Interfaz a Comptable": sends the same asientos MOVMES exports (FV, RC, NC,
 * ND, NT, NA of the last consolidated billing period, plus entries released
 * by a retiro) straight to Comptable, on demand. Its own channel: its own
 * lote (`LoteComptable`) and its own stamp (`AsientoContable.comptableLoteId`),
 * so it never affects the CSV export and vice versa.
 *
 * Send flow (idempotent): a transaction freezes the selection into a
 * `pendiente` lote whose `_id` is the `loteOrigenId`; the signed POST runs
 * outside it; only a 201 (or Comptable's "already received") stamps the
 * entries. A rejection marks the lote `fallido` and stamps nothing; no usable
 * answer (timeout, network, 5xx) leaves it `pendiente`, and only
 * "Reintentar" — same lote id, same entries — applies, which Comptable
 * deduplicates.
 *
 * Tenant from the request context on every query; the coproperty's
 * `comptableEmpresaId` is the whole authorization to talk to Comptable.
 */
@Injectable()
export class InterfazComptableService {
  constructor(
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(LoteComptable.name)
    private readonly lotes: Model<LoteComptableDocument>,
    @InjectModel(ConsecutivoLoteComptable.name)
    private readonly consecutivos: Model<ConsecutivoLoteComptableDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly resolucion: ResolucionDocumentosService,
    private readonly comptable: ComptableClient,
    private readonly tenant: TenantContextService,
    private readonly lotesFacturacion: LotesFacturacionService,
    @InjectConnection() private readonly connection: Connection,
    private readonly auditoria: AuditoriaService,
  ) {}

  /** What the screen needs first: is the server configured, is the active
   *  coproperty linked, is a lote waiting for "Reintentar". Never throws for
   *  a missing configuration — the screen explains it. */
  async estado(): Promise<EstadoInterfazComptable> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const copropiedad = await this.leerCopropiedad(copropiedadId);
    const pendiente = await this.lotes
      .findOne({ copropiedadId, estado: 'pendiente' })
      .exec();
    return {
      configurado: this.comptable.configurado(),
      comptableEmpresaId: copropiedad?.comptableEmpresaId ?? null,
      lotePendiente: pendiente ? toLoteComptable(pendiente) : null,
    };
  }

  /** History, newest first. */
  async listar(): Promise<LoteComptableContract[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const docs = await this.lotes
      .find({ copropiedadId })
      .sort({ numero: -1 })
      .exec();
    return docs.map(toLoteComptable);
  }

  /**
   * What "Enviar" would send now — counts, totals, inmuebles without titular
   * and the exact JSON (debug aid). While a lote is `pendiente` it describes
   * THAT lote, which is what "Reintentar" re-sends. Writes nothing (the
   * number in a fresh preview is only the next one, not reserved).
   */
  async pendientes(actor: ActorComptable): Promise<PendientesComptable> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const empresaId = await this.exigirEmpresa(copropiedadId);

    const pendiente = await this.lotes
      .findOne({ copropiedadId, estado: 'pendiente' })
      .exec();

    let asientos: AsientoContableDocument[];
    let periodoDesde: Date | null;
    let periodoHasta: Date | null;
    let origen: OrigenPayload | null;
    if (pendiente) {
      asientos = await this.asientosDelLote(pendiente, copropiedadId);
      periodoDesde = pendiente.periodoDesde;
      periodoHasta = pendiente.periodoHasta;
      origen = this.origenDelLote(pendiente, copropiedadId);
    } else {
      const seleccion = await this.seleccionar(copropiedadId, null);
      asientos = seleccion.asientos;
      periodoDesde = seleccion.periodoDesde;
      periodoHasta = seleccion.periodoHasta;
      origen = null;
    }

    const titulares = await this.cargarTitulares(copropiedadId, asientos, null);
    let payload: PayloadComptable | null = null;
    if (asientos.length > 0) {
      payload = await this.construirPayload(
        asientos,
        copropiedadId,
        titulares,
        origen ?? {
          copropiedadId,
          loteOrigenId: null,
          numeroLote: await this.siguienteNumeroPrevisto(copropiedadId),
          periodoDesde: periodoDesde,
          periodoHasta: periodoHasta,
          // Nobody generated anything yet: whoever is looking.
          generadoPor: actor,
        },
        null,
      );
    }

    const totales = totalesDe(asientos);
    return {
      comptableEmpresaId: empresaId,
      periodoDesde: periodoDesde?.toISOString() ?? null,
      periodoHasta: periodoHasta?.toISOString() ?? null,
      totalAsientos: totales.totalAsientos,
      totalLineas: totales.totalLineas,
      totalDebitos: aPesos(totales.totalDebitosCentavos),
      totalCreditos: aPesos(totales.totalCreditosCentavos),
      porDocumento: this.contarPorDocumento(asientos),
      inmueblesSinTitular: inmueblesSinTitular(asientos, titulares),
      lotePendiente: pendiente ? toLoteComptable(pendiente) : null,
      payload,
    };
  }

  /**
   * Asks Comptable to validate what "Enviar" would send (`simular=true`),
   * returning its summary or its errors verbatim. Writes nothing on either
   * side. With a `pendiente` lote it simulates THAT lote (same id), so an
   * "already received" answer tells the user a retry will just reconcile.
   */
  async simular(actor: ActorComptable): Promise<ResultadoSimulacionComptable> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    this.exigirConfiguracion();
    const empresaId = await this.exigirEmpresa(copropiedadId);

    const pendiente = await this.lotes
      .findOne({ copropiedadId, estado: 'pendiente' })
      .exec();

    let asientos: AsientoContableDocument[];
    let origen: OrigenPayload;
    if (pendiente) {
      asientos = await this.asientosDelLote(pendiente, copropiedadId);
      origen = this.origenDelLote(pendiente, copropiedadId);
    } else {
      const seleccion = await this.seleccionar(copropiedadId, null);
      asientos = seleccion.asientos;
      // A throwaway id: a simulation is never received, so it can never
      // collide with a real lote in Comptable.
      origen = {
        copropiedadId,
        loteOrigenId: new Types.ObjectId(),
        numeroLote: await this.siguienteNumeroPrevisto(copropiedadId),
        periodoDesde: seleccion.periodoDesde,
        periodoHasta: seleccion.periodoHasta,
        generadoPor: actor,
      };
    }
    if (asientos.length === 0) throw this.sinMovimientos();

    const titulares = await this.cargarTitulares(copropiedadId, asientos, null);
    const payload = await this.construirPayload(
      asientos,
      copropiedadId,
      titulares,
      origen,
      null,
    );
    const resultado = await this.comptable.enviarLote(
      empresaId,
      JSON.stringify(payload),
      true,
    );

    switch (resultado.tipo) {
      case 'ok':
        return {
          valido: true,
          resumen: resultado.datos,
          mensaje: null,
          errores: [],
        };
      case 'rechazado':
        return {
          valido: false,
          resumen: null,
          mensaje:
            resultado.mensaje ?? 'Comptable encontró errores en el lote.',
          errores: resultado.errores,
        };
      case 'duplicado':
        return {
          valido: false,
          resumen: null,
          mensaje:
            'Comptable ya recibió este lote. Usa "Reintentar" para registrarlo como enviado; no se duplicará.',
          errores: [],
        };
      case 'conflicto':
      case 'noEncontrado':
        return {
          valido: false,
          resumen: null,
          mensaje:
            resultado.mensaje ??
            (resultado.tipo === 'noEncontrado'
              ? 'Comptable no encontró la Empresa de esta copropiedad.'
              : 'Comptable no aceptó el lote.'),
          errores: [],
        };
      case 'noConfigurado':
        throw this.noConfigurado();
      case 'firma':
        throw new BadGatewayException(MENSAJE_FIRMA);
      default:
        throw new BadGatewayException(
          'No hubo respuesta de Comptable. Intenta de nuevo en unos minutos.',
        );
    }
  }

  /**
   * "Enviar": freezes the current selection into a new `pendiente` lote (in
   * a transaction, with its own number), then sends it. Refused while
   * another lote is `pendiente` (it must be retried, not bypassed), when
   * nothing is pending, or when an inmueble used as tercero has no titular
   * (Comptable could not create that tercero).
   */
  async enviar(actor: ActorComptable): Promise<ResultadoEnvioComptable> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    this.exigirConfiguracion();
    const empresaId = await this.exigirEmpresa(copropiedadId);
    await this.exigirSinPendiente(copropiedadId);

    let creado: {
      lote: LoteComptableDocument;
      asientos: AsientoContableDocument[];
    };
    try {
      creado = await this.transaccion(async (session) => {
        const seleccion = await this.seleccionar(copropiedadId, session);
        const { asientos } = seleccion;
        if (asientos.length === 0) throw this.sinMovimientos();

        const titulares = await this.cargarTitulares(
          copropiedadId,
          asientos,
          session,
        );
        this.exigirTitulares(asientos, titulares);

        const consecutivo = await this.consecutivos
          .findOneAndUpdate(
            { copropiedadId },
            { $inc: { siguienteNumero: 1 } },
            { returnDocument: 'after', upsert: true, session },
          )
          .exec();

        const totales = totalesDe(asientos);
        const [lote] = await this.lotes.create(
          [
            {
              copropiedadId,
              numero: consecutivo.siguienteNumero,
              periodoDesde: seleccion.periodoDesde,
              periodoHasta: seleccion.periodoHasta,
              asientoIds: asientos.map((a) => a._id),
              totalAsientos: totales.totalAsientos,
              totalLineas: totales.totalLineas,
              totalDebitos: aPesos(totales.totalDebitosCentavos),
              totalCreditos: aPesos(totales.totalCreditosCentavos),
              estado: 'pendiente',
              generadoPor: new Types.ObjectId(actor.accountId),
              generadoPorNombre: actor.nombre,
            },
          ],
          { session },
        );
        return { lote, asientos };
      });
    } catch (error) {
      // The partial unique index on `pendiente` lost a race against another
      // "Enviar": same answer as the check above.
      if ((error as { code?: number }).code === 11000) {
        throw this.hayPendiente();
      }
      throw error;
    }

    return this.despachar(
      creado.lote,
      creado.asientos,
      copropiedadId,
      empresaId,
      actor,
    );
  }

  /**
   * "Reintentar" a `pendiente` lote: rebuilds the payload from the SAME
   * entries under the SAME `loteOrigenId` and sends it again. Comptable
   * answers "already received" when the first attempt did land, which is
   * reconciled as sent.
   */
  async reintentar(
    loteId: string,
    actor: ActorComptable,
  ): Promise<ResultadoEnvioComptable> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    this.exigirConfiguracion();
    const empresaId = await this.exigirEmpresa(copropiedadId);
    const lote = await this.buscarLote(loteId, copropiedadId);
    if (lote.estado !== 'pendiente') {
      throw new ConflictException(
        `El lote ${lote.numero} no está pendiente: solo se reintenta un lote que quedó sin respuesta de Comptable.`,
      );
    }

    const asientos = await this.asientosDelLote(lote, copropiedadId);
    if (asientos.length !== lote.asientoIds.length) {
      throw new ConflictException(
        `Algunos movimientos del lote ${lote.numero} ya no existen en WebSACO Finanzas, así que no se puede reenviar igual. Comunícate con soporte.`,
      );
    }
    const titulares = await this.cargarTitulares(copropiedadId, asientos, null);
    this.exigirTitulares(asientos, titulares);

    return this.despachar(lote, asientos, copropiedadId, empresaId, actor);
  }

  /**
   * "Retirar" an `enviado` lote: Comptable first (it hard-deletes the lote's
   * asientos there); only on its success are the local stamps released
   * (`comptableLoteId: null`, `comptableLoteRetiradoId: lote`) so the next
   * "Enviar" picks those entries up again, and the lote becomes `retirado`
   * (kept as history). When the accountant edited the lote in Comptable,
   * Comptable refuses (`LOTE_INTERVENIDO`): its sentence is stored and
   * returned verbatim, and the lote stays `enviado` for good. When Comptable
   * says it already withdrew it (`LOTE_YA_RETIRADO`, e.g. an earlier call
   * that succeeded there but whose answer never arrived here), that is a
   * success too: withdrawing is idempotent. The actor travels in the signed
   * body (`solicitadoPor`) so Comptable's lote and audit name them.
   */
  async retirar(
    loteId: string,
    actor: ActorComptable,
  ): Promise<LoteComptableContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    this.exigirConfiguracion();
    const empresaId = await this.exigirEmpresa(copropiedadId);
    const lote = await this.buscarLote(loteId, copropiedadId);
    if (lote.estado !== 'enviado') {
      throw new ConflictException(
        `El lote ${lote.numero} no está enviado: solo se retira de Comptable un lote enviado.`,
      );
    }
    if (lote.intervenidoMensaje) {
      throw conflicto('LOTE_INTERVENIDO', lote.intervenidoMensaje);
    }

    const resultado = await this.comptable.retirarLote(
      empresaId,
      lote._id.toString(),
      actor,
    );

    switch (resultado.tipo) {
      case 'ok':
        return this.marcarRetirado(lote, copropiedadId, actor, false);
      case 'yaRetirado':
        return this.marcarRetirado(lote, copropiedadId, actor, true);
      case 'intervenido': {
        const mensaje =
          resultado.mensaje ??
          'El lote fue modificado en Comptable: ya no se puede retirar desde WebSACO Finanzas.';
        await this.marcarIntervenido(lote, copropiedadId, mensaje, actor);
        throw conflicto('LOTE_INTERVENIDO', mensaje);
      }
      case 'conflicto':
        throw new ConflictException(
          resultado.mensaje ?? 'Comptable no permitió retirar el lote.',
        );
      case 'noEncontrado':
        throw new ConflictException(
          resultado.mensaje ??
            `Comptable no tiene el lote ${lote.numero}; no se cambió nada aquí.`,
        );
      case 'rechazado':
        // Only a malformed request body gets here (a contract mismatch
        // between the two systems, not something the user can fix).
        throw new BadGatewayException(
          `Comptable rechazó la solicitud de retiro${resultado.mensaje ? `: ${resultado.mensaje}` : ''}. El lote ${lote.numero} sigue enviado.`,
        );
      case 'noConfigurado':
        throw this.noConfigurado();
      case 'firma':
        throw new BadGatewayException(MENSAJE_FIRMA);
      default:
        throw new BadGatewayException(
          `No hubo respuesta de Comptable; el lote ${lote.numero} sigue enviado. Intenta de nuevo en unos minutos.`,
        );
    }
  }

  /**
   * Sends one lote (first attempt or retry) and applies the outcome. Every
   * outcome is audited; only `ok`/`duplicado` stamp the entries.
   */
  private async despachar(
    lote: LoteComptableDocument,
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    empresaId: string,
    actor: ActorComptable,
  ): Promise<ResultadoEnvioComptable> {
    const titulares = await this.cargarTitulares(copropiedadId, asientos, null);
    const payload = await this.construirPayload(
      asientos,
      copropiedadId,
      titulares,
      this.origenDelLote(lote, copropiedadId),
      null,
    );
    // Serialized once: this exact string is signed and sent.
    const rawBody = JSON.stringify(payload);
    const resultado: ResultadoComptable<ResumenLoteComptable> =
      await this.comptable.enviarLote(empresaId, rawBody, false);

    switch (resultado.tipo) {
      case 'ok': {
        const enviado = await this.marcarEnviado(
          lote,
          copropiedadId,
          resultado.datos?.loteId ?? null,
          actor,
        );
        return {
          resultado: 'enviado',
          lote: toLoteComptable(enviado),
          resumen: resultado.datos ?? null,
          mensaje: null,
          errores: [],
        };
      }
      case 'duplicado': {
        const enviado = await this.marcarEnviado(
          lote,
          copropiedadId,
          resultado.loteId,
          actor,
        );
        return {
          resultado: 'enviado',
          lote: toLoteComptable(enviado),
          resumen: null,
          mensaje:
            'Comptable ya tenía este lote; quedó registrado como enviado.',
          errores: [],
        };
      }
      case 'rechazado': {
        const mensaje =
          resultado.mensaje ?? 'Comptable encontró errores en el lote.';
        const fallido = await this.marcarFallido(
          lote,
          copropiedadId,
          resultado.errores.length > 0
            ? `${mensaje} (${plural(resultado.errores.length, 'error', 'errores')})`
            : mensaje,
          actor,
        );
        return {
          resultado: 'fallido',
          lote: toLoteComptable(fallido),
          resumen: null,
          mensaje,
          errores: resultado.errores,
        };
      }
      case 'firma':
      case 'noEncontrado': {
        const mensaje =
          resultado.tipo === 'firma'
            ? MENSAJE_FIRMA
            : (resultado.mensaje ??
              'Comptable no encontró la Empresa de esta copropiedad: revisa el Id de la Empresa en Comptable.');
        const fallido = await this.marcarFallido(
          lote,
          copropiedadId,
          mensaje,
          actor,
        );
        return {
          resultado: 'fallido',
          lote: toLoteComptable(fallido),
          resumen: null,
          mensaje,
          errores: [],
        };
      }
      default: {
        // timeout, red, inesperado (5xx), an unrecognized 409, or the
        // configuration vanishing mid-request: the outcome is unknown, so
        // nothing is stamped and the lote stays `pendiente` for a retry with
        // the same id (which Comptable deduplicates).
        const detalle =
          resultado.tipo === 'conflicto' && resultado.mensaje
            ? ` Comptable respondió: ${resultado.mensaje}`
            : '';
        const mensaje = `No hubo una respuesta clara de Comptable. El lote ${lote.numero} quedó pendiente: usa "Reintentar"; Comptable no lo duplicará.${detalle}`;
        await this.registrarAuditoria(
          actor,
          'actualizar',
          lote,
          copropiedadId,
          `sin respuesta clara de Comptable (${resultado.tipo}): queda pendiente`,
          null,
        );
        return {
          resultado: 'pendiente',
          lote: toLoteComptable(lote),
          resumen: null,
          mensaje,
          errores: [],
        };
      }
    }
  }

  /** `pendiente` → `enviado` + stamps, in one transaction with its audit
   *  entry. Conditional on still being `pendiente`: a concurrent retry that
   *  already reconciled it is not an error, the current row is returned. */
  private async marcarEnviado(
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
    comptableLoteId: string | null,
    actor: ActorComptable,
  ): Promise<LoteComptableDocument> {
    return this.transaccion(async (session) => {
      const actualizado = await this.lotes
        .findOneAndUpdate(
          { _id: lote._id, copropiedadId, estado: 'pendiente' },
          {
            $set: {
              estado: 'enviado',
              comptableLoteId,
              enviadoPor: new Types.ObjectId(actor.accountId),
              enviadoPorNombre: actor.nombre,
              enviadoEn: new Date(),
            },
          },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!actualizado) {
        return (await this.lotes
          .findOne({ _id: lote._id, copropiedadId })
          .session(session)
          .exec())!;
      }

      await this.asientos.updateMany(
        { _id: { $in: lote.asientoIds }, copropiedadId },
        { $set: { comptableLoteId: lote._id } },
        { session },
      );

      await this.registrarAuditoria(
        actor,
        'crear',
        actualizado,
        copropiedadId,
        `enviado: ${plural(actualizado.totalAsientos, 'documento', 'documentos')}`,
        session,
      );
      return actualizado;
    });
  }

  /** `pendiente` → `fallido` with the reason; nothing stamped. */
  private async marcarFallido(
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
    motivoFallo: string,
    actor: ActorComptable,
  ): Promise<LoteComptableDocument> {
    return this.transaccion(async (session) => {
      const actualizado = await this.lotes
        .findOneAndUpdate(
          { _id: lote._id, copropiedadId, estado: 'pendiente' },
          { $set: { estado: 'fallido', motivoFallo } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!actualizado) {
        return (await this.lotes
          .findOne({ _id: lote._id, copropiedadId })
          .session(session)
          .exec())!;
      }
      await this.registrarAuditoria(
        actor,
        'actualizar',
        actualizado,
        copropiedadId,
        `rechazado por Comptable: ${motivoFallo}`,
        session,
      );
      return actualizado;
    });
  }

  /** `enviado` → `retirado`, releasing the stamps, after Comptable deleted
   *  the lote there — now, or earlier (`yaRetirado`, said in the audit). */
  private async marcarRetirado(
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
    actor: ActorComptable,
    yaRetirado: boolean,
  ): Promise<LoteComptableContract> {
    return this.transaccion(async (session) => {
      const actualizado = await this.lotes
        .findOneAndUpdate(
          { _id: lote._id, copropiedadId, estado: 'enviado' },
          {
            $set: {
              estado: 'retirado',
              retiradoPor: new Types.ObjectId(actor.accountId),
              retiradoPorNombre: actor.nombre,
              retiradoEn: new Date(),
            },
          },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!actualizado) {
        throw new ConflictException(`El lote ${lote.numero} ya fue retirado.`);
      }

      await this.asientos.updateMany(
        { copropiedadId, comptableLoteId: lote._id },
        {
          $set: {
            comptableLoteId: null,
            comptableLoteRetiradoId: lote._id,
          },
        },
        { session },
      );

      await this.registrarAuditoria(
        actor,
        'retirar',
        actualizado,
        copropiedadId,
        `${yaRetirado ? 'retirado (Comptable ya lo había retirado)' : 'retirado de Comptable'}: ${plural(actualizado.totalAsientos, 'documento vuelve', 'documentos vuelven')} a pendientes`,
        session,
      );
      return toLoteComptable(actualizado);
    });
  }

  /** Records Comptable's "edited there" refusal; the lote stays `enviado`. */
  private async marcarIntervenido(
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
    mensaje: string,
    actor: ActorComptable,
  ): Promise<void> {
    await this.transaccion(async (session) => {
      const actualizado = await this.lotes
        .findOneAndUpdate(
          { _id: lote._id, copropiedadId, estado: 'enviado' },
          { $set: { intervenidoMensaje: mensaje, intervenidoEn: new Date() } },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!actualizado) return;
      await this.registrarAuditoria(
        actor,
        'actualizar',
        actualizado,
        copropiedadId,
        'no se pudo retirar: fue modificado en Comptable',
        session,
      );
    });
  }

  /**
   * Same selection as MOVMES, on this channel's own stamp: entries of the
   * last consolidated billing period not yet sent to Comptable, plus any
   * entry a retiro released, whatever its date. The CSV stamp plays no part.
   */
  private async seleccionar(
    copropiedadId: Types.ObjectId,
    session: ClientSession | null,
  ): Promise<{
    asientos: AsientoContableDocument[];
    periodoDesde: Date;
    periodoHasta: Date;
  }> {
    const ultimoLote = await this.lotesFacturacion.obtenerUltimoConsolidado(
      copropiedadId.toString(),
    );
    if (!ultimoLote) {
      throw new BadRequestException(
        'Esta copropiedad todavía no tiene un período de facturación consolidado.',
      );
    }
    const asientos = await this.asientos
      .find({
        copropiedadId,
        comptableLoteId: null,
        $or: [
          {
            fecha: {
              $gte: ultimoLote.periodoDesde,
              $lte: ultimoLote.periodoHasta,
            },
          },
          { comptableLoteRetiradoId: { $ne: null } },
        ],
      })
      .sort({ fecha: 1, _id: 1 })
      .session(session)
      .exec();
    return {
      asientos,
      periodoDesde: ultimoLote.periodoDesde,
      periodoHasta: ultimoLote.periodoHasta,
    };
  }

  /** The exact entries a lote froze, tenant-scoped, in send order. */
  private asientosDelLote(
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
  ): Promise<AsientoContableDocument[]> {
    return this.asientos
      .find({ _id: { $in: lote.asientoIds }, copropiedadId })
      .sort({ fecha: 1, _id: 1 })
      .exec();
  }

  private origenDelLote(
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
  ): OrigenPayload {
    return {
      copropiedadId,
      loteOrigenId: lote._id,
      numeroLote: lote.numero,
      periodoDesde: lote.periodoDesde,
      periodoHasta: lote.periodoHasta,
      // Always the lote's author, so a retry re-sends the same payload.
      generadoPor: {
        accountId: lote.generadoPor.toString(),
        nombre: lote.generadoPorNombre,
      },
    };
  }

  private async construirPayload(
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    titulares: TitularesPorInmueble,
    origen: OrigenPayload,
    session: ClientSession | null,
  ): Promise<PayloadComptable> {
    const anchorMap = await this.resolucion.buildAnchorMap(
      asientos,
      copropiedadId,
      session,
    );
    const conceptoMap = await this.resolucion.resolveConceptos(
      asientos,
      copropiedadId,
      session,
    );
    const saldosInicialesPorNumero =
      await this.resolucion.resolverSaldosIniciales(
        asientos,
        copropiedadId,
        session,
      );
    return construirPayloadComptable(
      asientos,
      { anchorMap, conceptoMap, saldosInicialesPorNumero },
      titulares,
      origen,
    );
  }

  /**
   * Inmueble code → its titular (`Inmueble.titularId` → `Tercero`), both
   * lookups tenant-scoped. A code with no inmueble, or an inmueble with no
   * titular, maps to `null`.
   */
  private async cargarTitulares(
    copropiedadId: Types.ObjectId,
    asientos: AsientoContableDocument[],
    session: ClientSession | null,
  ): Promise<TitularesPorInmueble> {
    const codigos = codigosTercero(asientos);
    const titulares: TitularesPorInmueble = new Map(
      codigos.map((codigo) => [codigo, null]),
    );
    if (codigos.length === 0) return titulares;

    const inmuebles = await this.inmuebles
      .find(
        { copropiedadId, codigo: { $in: codigos } },
        { codigo: 1, titularId: 1 },
      )
      .session(session)
      .exec();
    const titularIds = inmuebles
      .map((i) => i.titularId)
      .filter((id): id is Types.ObjectId => Boolean(id));
    if (titularIds.length === 0) return titulares;

    const terceros = await this.terceros
      .find({ _id: { $in: titularIds }, copropiedadId })
      .session(session)
      .exec();
    const terceroPorId = new Map(terceros.map((t) => [t._id.toString(), t]));
    for (const inmueble of inmuebles) {
      const tercero = inmueble.titularId
        ? terceroPorId.get(inmueble.titularId.toString())
        : undefined;
      if (tercero) titulares.set(inmueble.codigo, tercero);
    }
    return titulares;
  }

  private contarPorDocumento(
    asientos: AsientoContableDocument[],
  ): ConteoDocumentoComptable[] {
    const conteo = new Map<TipoDocumentoExport, ConteoDocumentoComptable>();
    for (const asiento of asientos) {
      const documento = tipoDocumentoDe(asiento);
      const fila = conteo.get(documento) ?? {
        documento,
        asientos: 0,
        lineas: 0,
      };
      fila.asientos += 1;
      fila.lineas += asiento.movimientos.length;
      conteo.set(documento, fila);
    }
    return ORDEN_DOCUMENTOS.filter((d) => conteo.has(d)).map((d) =>
      conteo.get(d)!,
    );
  }

  /** The number a new lote would get — read only, never reserved. */
  private async siguienteNumeroPrevisto(
    copropiedadId: Types.ObjectId,
  ): Promise<number> {
    const consecutivo = await this.consecutivos
      .findOne({ copropiedadId })
      .exec();
    return (consecutivo?.siguienteNumero ?? 0) + 1;
  }

  private async leerCopropiedad(
    copropiedadId: Types.ObjectId,
  ): Promise<Pick<
    Copropiedad,
    'codigo' | 'nombre' | 'comptableEmpresaId'
  > | null> {
    // `Copropiedad` IS the tenant, so `findById` with the tenant's own id is
    // the right lookup here (the tenancy law's warning is about other
    // collections).
    return this.copropiedades
      .findById(copropiedadId)
      .select('codigo nombre comptableEmpresaId')
      .lean()
      .exec();
  }

  private exigirConfiguracion(): void {
    if (!this.comptable.configurado()) throw this.noConfigurado();
  }

  private async exigirEmpresa(copropiedadId: Types.ObjectId): Promise<string> {
    const copropiedad = await this.leerCopropiedad(copropiedadId);
    const empresaId = copropiedad?.comptableEmpresaId ?? null;
    if (!empresaId) {
      throw conflicto(
        'SIN_EMPRESA',
        'Esta copropiedad no tiene Empresa de Comptable configurada.',
      );
    }
    return empresaId;
  }

  private async exigirSinPendiente(
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    const pendiente = await this.lotes
      .exists({ copropiedadId, estado: 'pendiente' })
      .exec();
    if (pendiente) throw this.hayPendiente();
  }

  private exigirTitulares(
    asientos: AsientoContableDocument[],
    titulares: TitularesPorInmueble,
  ): void {
    const sinTitular = inmueblesSinTitular(asientos, titulares);
    if (sinTitular.length > 0) {
      throw conflicto(
        'INMUEBLES_SIN_TITULAR',
        `Estos inmuebles no tienen titular y Comptable no puede crear su tercero: ${sinTitular.join(', ')}. Asígnales un titular antes de enviar.`,
        { inmuebles: sinTitular },
      );
    }
  }

  private noConfigurado(): ConflictException {
    return conflicto(
      'NO_CONFIGURADO',
      'La integración con Comptable no está configurada en este servidor.',
    );
  }

  private hayPendiente(): ConflictException {
    return conflicto(
      'LOTE_PENDIENTE',
      'Hay un lote pendiente sin respuesta de Comptable. Usa "Reintentar" en ese lote antes de enviar otro.',
    );
  }

  private sinMovimientos(): ConflictException {
    return conflicto(
      'SIN_MOVIMIENTOS',
      'No hay movimientos nuevos por enviar a Comptable en el período actual.',
    );
  }

  /** Tenant-scoped lookup — never `findById` (see the tenancy law). */
  private async buscarLote(
    loteId: string,
    copropiedadId: Types.ObjectId,
  ): Promise<LoteComptableDocument> {
    const lote = Types.ObjectId.isValid(loteId)
      ? await this.lotes
          .findOne({ _id: new Types.ObjectId(loteId), copropiedadId })
          .exec()
      : null;
    if (!lote) {
      throw new NotFoundException(
        'No existe ese lote de Interfaz a Comptable.',
      );
    }
    return lote;
  }

  /** Audit entry labelled with the coproperty (the log spans every
   *  building), inside the caller's transaction when there is one. */
  private async registrarAuditoria(
    actor: ActorComptable,
    accion: 'crear' | 'actualizar' | 'retirar',
    lote: LoteComptableDocument,
    copropiedadId: Types.ObjectId,
    detalle: string,
    session: ClientSession | null,
  ): Promise<void> {
    const copropiedad = await this.leerCopropiedad(copropiedadId);
    const etiquetaCopropiedad =
      [copropiedad?.codigo, copropiedad?.nombre].filter(Boolean).join(' ') ||
      copropiedadId.toString();
    await this.auditoria.registrar(
      {
        actorAccountId: actor.accountId,
        actorNombre: actor.nombre,
        accion,
        entidadTipo: 'lote-comptable',
        entidadId: lote._id.toString(),
        entidadEtiqueta: `Lote ${lote.numero} de Interfaz a Comptable de ${etiquetaCopropiedad} ${detalle}`,
      },
      session ?? undefined,
    );
  }

  private async transaccion<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let resultado!: T;
      await session.withTransaction(async () => {
        resultado = await fn(session);
      });
      return resultado;
    } finally {
      await session.endSession();
    }
  }
}
