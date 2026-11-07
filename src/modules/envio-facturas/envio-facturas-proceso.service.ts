// src/modules/envio-facturas/envio-facturas-proceso.service.ts
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type ResidenteDeInmueble,
} from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ResultadoProcesoEnvio } from '../../contracts';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  EnvioFactura,
  type EnvioFacturaDocument,
  type MotivoErrorEnvio,
} from '../../database/schemas/facturacion/envio-factura.schema';
import {
  Factura,
  type FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import {
  construirAsuntoFactura,
  construirCorreoFactura,
  etiquetaPeriodo,
} from './envio-factura-correo';
import {
  ENVIOS_SIMULTANEOS,
  esperaTrasFallo,
  filtroReclamable,
  LIMITE_POR_LLAMADA,
  MAX_INTENTOS,
  PRESUPUESTO_MS,
  VIGENCIA_ENLACE_MS,
} from './envio-facturas.constantes';
import { cuentaDe } from './envio-facturas.service';

/** Which of the two progress arrays of a row. */
type CampoProgreso = 'notificadosIds' | 'correosEnviadosIds';

/** What one row ended up as in a call. */
interface ResultadoFila {
  tipo: 'enviada' | 'reintentable' | 'error';
  correos: number;
  /** Unit code, when the row ended with nobody to reach. */
  sinDestinatario?: string;
}

/** Everything a call shares between its rows. */
interface ContextoProceso {
  copropiedadId: Types.ObjectId;
  token: string;
  nombreCopropiedad: string;
  facturas: Map<
    string,
    { estado: string; numeroCompleto: string; periodoDesde?: Date }
  >;
  residentes: Map<string, ResidenteDeInmueble[]>;
}

/**
 * Delivers the queued invoices to the people who hold their units, INSIDE the
 * request that pressed "send" (`POST procesar-pendientes`). NOTHING ELSE EVER
 * SENDS: marking only queues, and no event, cron or setting calls this.
 *
 * Same design as the block billing and the announcements (the host only has CPU
 * while a request is open, so no queue and no worker):
 *
 * - A call claims up to {@link LIMITE_POR_LLAMADA} rows with ONE atomic
 *   `updateMany` whose filter is the claimable test itself, so two concurrent
 *   calls (two clicks, two instances) win disjoint sets and never the same row.
 * - It delivers in batches of {@link ENVIOS_SIMULTANEOS} and renews the lease of
 *   the rest after each batch (the heartbeat); a call that stops early releases
 *   what it did not reach, and one that died leaves its rows to expire.
 * - Progress is recorded per (invoice, recipient) with `$addToSet` AFTER each
 *   delivery succeeded, so processing again only reaches whoever is missing: a
 *   retry after a cut request never notifies anybody twice.
 * - A failing recipient is logged and left pending; the others still get theirs.
 *   The row retries with a growing backoff and, after {@link MAX_INTENTOS}
 *   failures, waits in `error` for a human to queue it again.
 *
 * WHO receives it: owner AND tenant of the unit (`DirectorioService`). A unit with
 * no tenant, or a party with no account or no active sign-in, is simply not in
 * the list; a unit with NOBODY reachable ends in `error: sin_destinatarios`, which
 * is reported, never thrown. The notice carries a link, never the PDF or amounts.
 *
 * Trade-off, stated plainly: progress is written after the send, so a crash in
 * the instant between the provider accepting an email and the write can send
 * that one email twice on resume (writing first would silently lose it instead),
 * and a lease that expired while its holder was merely slow can overlap with the
 * next claimer on the rows of ONE batch.
 */
@Injectable()
export class EnvioFacturasProcesoService {
  private readonly logger = new Logger(EnvioFacturasProcesoService.name);

  constructor(
    @InjectModel(EnvioFactura.name)
    private readonly envios: Model<EnvioFacturaDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Takes the next slice of the queue, delivers it, and answers how far it got.
   * The screen calls again while `hayMas` is true. Refused with 409 BEFORE any
   * row is touched when the environment cannot send email: the notice IS the
   * email, and a row must never be marked `enviado` without it.
   */
  async procesarPendientes(user: IRequestUser): Promise<ResultadoProcesoEnvio> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cuenta = cuentaDe(user);
    if (!this.correo.estaConfigurado()) {
      throw new ConflictException(
        'El correo no está configurado en este entorno: no se puede enviar. Configure SENDGRID_API_KEY y SENDGRID_FROM_EMAIL.',
      );
    }

    const corridaId = new Types.ObjectId();
    const token = corridaId.toString();
    const filas = await this.reclamar(
      copropiedadId,
      token,
      corridaId,
      cuenta,
      user.nombre ?? '',
    );

    const resultado: ResultadoProcesoEnvio = {
      reclamadas: filas.length,
      enviadas: 0,
      reintentables: 0,
      conError: 0,
      correosEnviados: 0,
      unidadesSinDestinatario: [],
      pendientes: 0,
      enCurso: 0,
      hayMas: false,
    };

    if (filas.length > 0) {
      try {
        // Audited BEFORE anything leaves: a send can never go unrecorded.
        await this.auditoria.registrar({
          actorAccountId: cuenta.toString(),
          actorNombre: user.nombre ?? '',
          accion: 'enviar',
          entidadTipo: 'envio-factura',
          entidadId: corridaId.toString(),
          entidadEtiqueta: `Envío de facturas: ${filas.length} reclamadas`,
        });
        await this.entregar(filas, copropiedadId, token, resultado);
      } finally {
        await this.soltar(copropiedadId, token);
      }
    }

    const ahora = new Date();
    const [pendientes, enCola] = await Promise.all([
      this.envios.countDocuments(filtroReclamable(copropiedadId, ahora)).exec(),
      this.envios
        .countDocuments({ copropiedadId, estado: 'pendiente_envio' })
        .exec(),
    ]);
    resultado.pendientes = pendientes;
    resultado.enCurso = enCola - pendientes;
    resultado.unidadesSinDestinatario.sort();
    // Stop when this call could not take anything: whatever is left is held by
    // another processor or waiting out a backoff, and repeating would spin.
    resultado.hayMas = resultado.reclamadas > 0 && pendientes > 0;
    return resultado;
  }

  /**
   * Takes the lease on up to {@link LIMITE_POR_LLAMADA} claimable rows, oldest mark
   * first. Two steps, both safe: pick candidates, then ONE `updateMany` whose
   * filter repeats the claimable test, so a row someone else took in between is
   * simply not updated. What this call really won is whatever carries its token.
   * `liberadaEn` is set with `$min` so only the FIRST claim ever stamps it.
   */
  private async reclamar(
    copropiedadId: Types.ObjectId,
    token: string,
    corridaId: Types.ObjectId,
    cuenta: Types.ObjectId,
    nombre: string,
  ): Promise<EnvioFacturaDocument[]> {
    const ahora = new Date();
    const candidatos = await this.envios
      .find(filtroReclamable(copropiedadId, ahora))
      .sort({ marcadoEn: 1, _id: 1 })
      .limit(LIMITE_POR_LLAMADA)
      .select('_id')
      .lean()
      .exec();
    if (candidatos.length === 0) return [];

    await this.envios
      .updateMany(
        {
          ...filtroReclamable(copropiedadId, ahora),
          _id: { $in: candidatos.map((c) => c._id) },
        },
        {
          $set: {
            tokenEnvio: token,
            envioIniciadoEn: ahora,
            procesadoPorId: cuenta,
            procesadoPorNombre: nombre,
            ultimaCorridaId: corridaId,
          },
          $min: { liberadaEn: ahora },
        },
      )
      .exec();

    return this.envios
      .find({ copropiedadId, tokenEnvio: token })
      .sort({ marcadoEn: 1, _id: 1 })
      .exec();
  }

  /** Delivers the claimed rows in batches, renewing the lease between them. */
  private async entregar(
    filas: EnvioFacturaDocument[],
    copropiedadId: Types.ObjectId,
    token: string,
    resultado: ResultadoProcesoEnvio,
  ): Promise<void> {
    const facturas = await this.facturas
      .find({ copropiedadId, _id: { $in: filas.map((f) => f.facturaId) } })
      .select('estado numeroCompleto periodoDesde')
      .lean()
      .exec();
    const unidades = [
      ...new Map(
        filas.map((f) => [f.inmuebleId.toString(), f.inmuebleId]),
      ).values(),
    ];
    const residentes = await this.directorio.residentesDeInmuebles(
      copropiedadId,
      unidades,
    );
    // `findById` is allowed here: the id IS the tenant.
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('nombre')
      .exec();

    const contexto: ContextoProceso = {
      copropiedadId,
      token,
      nombreCopropiedad: copropiedad?.nombre ?? '',
      facturas: new Map(facturas.map((f) => [f._id.toString(), f])),
      residentes,
    };

    const inicio = Date.now();
    for (let i = 0; i < filas.length; i += ENVIOS_SIMULTANEOS) {
      // Out of time: stop STARTING work and answer; the rest is released and the
      // screen calls again.
      if (Date.now() - inicio > PRESUPUESTO_MS) return;
      const resultados = await Promise.all(
        filas
          .slice(i, i + ENVIOS_SIMULTANEOS)
          .map((fila) => this.entregarFila(fila, contexto)),
      );
      for (const r of resultados) {
        resultado.correosEnviados += r.correos;
        if (r.tipo === 'enviada') resultado.enviadas += 1;
        else if (r.tipo === 'reintentable') resultado.reintentables += 1;
        else resultado.conError += 1;
        if (r.sinDestinatario) {
          resultado.unidadesSinDestinatario.push(r.sinDestinatario);
        }
      }
      // Heartbeat. No match with rows still to do means another processor took
      // over after ours stalled: they are not ours any more, stop.
      if (i + ENVIOS_SIMULTANEOS < filas.length) {
        if (!(await this.latido(copropiedadId, token))) return;
      }
    }
  }

  /**
   * One row: resolves its recipients, delivers to whoever is missing, then settles
   * the row. Never throws, so one bad row cannot stop the others in its batch.
   */
  private async entregarFila(
    fila: EnvioFacturaDocument,
    contexto: ContextoProceso,
  ): Promise<ResultadoFila> {
    const etiqueta = `${fila._id.toString()} (factura ${fila.facturaId.toString()})`;
    try {
      const factura = contexto.facturas.get(fila.facturaId.toString());
      if (!factura)
        return await this.cerrarConError(fila, contexto, 'factura_inexistente');
      // A notice about a voided invoice would be wrong; checked HERE because the
      // invoice may have been voided after it was queued.
      if (factura.estado !== 'emitida') {
        return await this.cerrarConError(fila, contexto, 'factura_anulada');
      }

      const elegibles = this.sinRepetidos(
        contexto.residentes.get(fila.inmuebleId.toString()) ?? [],
      );
      if (elegibles.length === 0) {
        const r = await this.cerrarConError(
          fila,
          contexto,
          'sin_destinatarios',
        );
        return { ...r, sinDestinatario: fila.codigoInmueble };
      }

      const notificados = new Set(fila.notificadosIds.map(String));
      const enviados = new Set(fila.correosEnviadosIds.map(String));
      let correos = 0;
      for (const residente of elegibles) {
        correos += await this.entregarA(
          fila,
          residente,
          factura,
          contexto,
          notificados,
          enviados,
        );
      }

      const completo = elegibles.every(
        (r) => notificados.has(r.accountId) && enviados.has(r.accountId),
      );
      if (completo) {
        await this.cerrarEnviada(fila, contexto, elegibles.length);
        return { tipo: 'enviada', correos };
      }
      return {
        ...(await this.cerrarConFallo(fila, contexto, elegibles.length)),
        correos,
      };
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo procesar el envío ${etiqueta}: ${(error as Error).message}`,
      );
      try {
        return await this.cerrarConFallo(
          fila,
          contexto,
          fila.destinatariosTotal,
        );
      } catch {
        return { tipo: 'reintentable', correos: 0 };
      }
    }
  }

  /** The same account twice for one unit would get one notice twice. */
  private sinRepetidos(
    residentes: ResidenteDeInmueble[],
  ): ResidenteDeInmueble[] {
    return [...new Map(residentes.map((r) => [r.accountId, r])).values()];
  }

  /**
   * One recipient: the in-app entry (if missing), then the email (if missing).
   * Returns how many emails the provider accepted (0 or 1). Never throws; whatever
   * failed simply stays unrecorded and pending.
   */
  private async entregarA(
    fila: EnvioFacturaDocument,
    residente: ResidenteDeInmueble,
    factura: { numeroCompleto: string; periodoDesde?: Date },
    contexto: ContextoProceso,
    notificados: Set<string>,
    enviados: Set<string>,
  ): Promise<number> {
    // Account id, never the address: the log is not a place for personal data.
    const etiqueta = `${fila._id.toString()} a la cuenta ${residente.accountId}`;
    try {
      if (!notificados.has(residente.accountId)) {
        const guardada = await this.notificaciones.crear({
          copropiedadId: contexto.copropiedadId,
          accountId: residente.accountId,
          tipo: 'pago',
          titulo: construirAsuntoFactura(factura.numeroCompleto),
        });
        // Not stored = still pending: the row is retried, never faked as sent.
        if (guardada) {
          await this.registrar(
            fila,
            'notificadosIds',
            residente.accountId,
            contexto,
          );
          notificados.add(residente.accountId);
        }
      }

      if (enviados.has(residente.accountId)) return 0;
      const enlace = await this.enlaces.construir(
        residente.accountId,
        contexto.copropiedadId.toString(),
        `/portal/facturas?inmuebleId=${fila.inmuebleId.toString()}&abrir=${fila.facturaId.toString()}`,
        VIGENCIA_ENLACE_MS,
      );
      const { asunto, html } = construirCorreoFactura({
        nombreDestinatario: residente.nombre,
        nombreCopropiedad: contexto.nombreCopropiedad,
        numeroCompleto: factura.numeroCompleto,
        codigoInmueble: fila.codigoInmueble,
        periodo: etiquetaPeriodo(factura.periodoDesde),
        enlace,
      });
      const aceptado = await this.correo.enviar({
        para: residente.email,
        asunto,
        html,
      });
      if (!aceptado) {
        this.logger.error(`No se pudo enviar la factura ${etiqueta}.`);
        return 0;
      }
      await this.registrar(
        fila,
        'correosEnviadosIds',
        residente.accountId,
        contexto,
      );
      enviados.add(residente.accountId);
      return 1;
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo entregar la factura ${etiqueta}: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /** Records one recipient as reached. Idempotent: `$addToSet` never duplicates. */
  private async registrar(
    fila: EnvioFacturaDocument,
    campo: CampoProgreso,
    accountId: string,
    contexto: ContextoProceso,
  ): Promise<void> {
    await this.envios
      .updateOne(
        { _id: fila._id, copropiedadId: contexto.copropiedadId },
        { $addToSet: { [campo]: new Types.ObjectId(accountId) } },
      )
      .exec();
  }

  /** Every recipient reached: the row is `enviado` and the lease is released. */
  private async cerrarEnviada(
    fila: EnvioFacturaDocument,
    contexto: ContextoProceso,
    destinatarios: number,
  ): Promise<void> {
    await this.envios
      .updateOne(
        {
          _id: fila._id,
          copropiedadId: contexto.copropiedadId,
          tokenEnvio: contexto.token,
        },
        {
          $set: {
            estado: 'enviado',
            enviadoEn: new Date(),
            destinatariosTotal: destinatarios,
            ultimoError: null,
            proximoIntentoEn: null,
            tokenEnvio: null,
            envioIniciadoEn: null,
          },
        },
      )
      .exec();
  }

  /** Nothing to retry (no recipients, voided invoice): the row waits in `error`. */
  private async cerrarConError(
    fila: EnvioFacturaDocument,
    contexto: ContextoProceso,
    motivo: MotivoErrorEnvio,
  ): Promise<ResultadoFila> {
    await this.envios
      .updateOne(
        {
          _id: fila._id,
          copropiedadId: contexto.copropiedadId,
          tokenEnvio: contexto.token,
        },
        {
          $set: {
            estado: 'error',
            ultimoError: motivo,
            destinatariosTotal: 0,
            tokenEnvio: null,
            envioIniciadoEn: null,
          },
        },
      )
      .exec();
    return { tipo: 'error', correos: 0 };
  }

  /**
   * Somebody could not be reached: count the failure and queue the retry after a
   * growing wait, or, past {@link MAX_INTENTOS}, park the row in `error`.
   */
  private async cerrarConFallo(
    fila: EnvioFacturaDocument,
    contexto: ContextoProceso,
    destinatarios: number,
  ): Promise<ResultadoFila> {
    const intentos = fila.intentos + 1;
    const agotada = intentos >= MAX_INTENTOS;
    await this.envios
      .updateOne(
        {
          _id: fila._id,
          copropiedadId: contexto.copropiedadId,
          tokenEnvio: contexto.token,
        },
        {
          $set: {
            intentos,
            destinatariosTotal: destinatarios,
            tokenEnvio: null,
            envioIniciadoEn: null,
            ...(agotada
              ? { estado: 'error', ultimoError: 'reintentos_agotados' }
              : {
                  proximoIntentoEn: new Date(
                    Date.now() + esperaTrasFallo(intentos),
                  ),
                }),
          },
        },
      )
      .exec();
    return { tipo: agotada ? 'error' : 'reintentable', correos: 0 };
  }

  /** Renews the lease of what this call still holds; false when it holds nothing. */
  private async latido(
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<boolean> {
    const r = await this.envios
      .updateMany(
        { copropiedadId, tokenEnvio: token },
        { $set: { envioIniciadoEn: new Date() } },
      )
      .exec();
    return r.matchedCount > 0;
  }

  /** Releases whatever this call still holds (not reached, or an error escaped). */
  private async soltar(
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<void> {
    try {
      await this.envios
        .updateMany(
          { copropiedadId, tokenEnvio: token },
          { $set: { tokenEnvio: null, envioIniciadoEn: null } },
        )
        .exec();
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo liberar el envío de facturas ${token}: ${(error as Error).message}`,
      );
    }
  }
}
