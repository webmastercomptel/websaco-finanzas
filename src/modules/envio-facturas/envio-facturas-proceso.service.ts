// src/modules/envio-facturas/envio-facturas-proceso.service.ts
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import type { DestinoCorreo } from '../../common/directorio/destinos-correo';
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
import { EnlaceFacturaService } from '../factura-publica/enlace-factura.service';
import { diagnosticarFrontendUrl } from '../health/frontend-url.health';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import {
  construirAsuntoFactura,
  construirCorreoFactura,
  construirEnlacePdf,
  construirUrlPortal,
  etiquetaFechaVencimiento,
  etiquetaPeriodo,
} from './envio-factura-correo';
import {
  contarCola,
  ENVIOS_SIMULTANEOS,
  esperaTrasFallo,
  filtroReclamable,
  LIMITE_POR_LLAMADA,
  MAX_INTENTOS,
  PRESUPUESTO_MS,
} from './envio-facturas.constantes';
import { cuentaDe } from './envio-facturas.service';

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
  /** Accounts to notify in-app, per unit. */
  residentes: Map<string, ResidenteDeInmueble[]>;
  /** Addresses to e-mail, per unit (from the party RECORDS, not accounts). */
  destinos: Map<string, DestinoCorreo[]>;
  /** Validated origin the links are built from. */
  frontendUrl: string;
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
 * - Progress is recorded per ADDRESS (`correosEntregados`, a conditional
 *   `$push` on `clave`) and per account for the in-app notice (`$addToSet`),
 *   AFTER each delivery succeeded, so processing again only reaches whoever is
 *   missing: a retry after a cut request never e-mails an address twice.
 * - A failing recipient is logged and left pending; the others still get theirs.
 *   The row retries with a growing backoff and, after {@link MAX_INTENTOS}
 *   failures, waits in `error` for a human to queue it again.
 *
 * WHO receives it. E-mail: every valid address on the records of the unit's
 * owner AND tenant (`DirectorioService.correosDeInmuebles`), whether or not any of
 * them has an account; each address gets its own e-mail with its own personal
 * link to the PDF (`EnlaceFacturaService`). In-app notice: the accounts linked to
 * those parties (`residentesDeInmuebles`), unchanged. A unit with NO address on
 * file ends in `error: sin_destinatarios` (its linked accounts still get their
 * notice), which is reported, never thrown. The e-mail carries a link, never the
 * PDF or amounts, and no sign-in link.
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
    private readonly enlaces: EnlaceFacturaService,
    private readonly notificaciones: NotificacionesService,
    private readonly auditoria: AuditoriaService,
    private readonly config: ConfigService,
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
    // Every link in the e-mail is built from FRONTEND_URL; without a usable one
    // a row would end `enviado` with a dead button. The messages name the
    // setting and never a value.
    const diagnostico = diagnosticarFrontendUrl(
      this.config.get<string>('app.frontendUrl'),
    );
    if (diagnostico === 'falta') {
      throw new ConflictException(
        'No se puede enviar: falta configurar FRONTEND_URL, la dirección pública de la aplicación, con la que se arman los enlaces de las facturas.',
      );
    }
    if (diagnostico === 'malformada') {
      throw new ConflictException(
        'No se puede enviar: FRONTEND_URL debe ser solo la dirección pública (esquema y dominio, sin ruta ni parámetros).',
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
      enEspera: 0,
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
    const { pendientes, enCurso, enEspera } = await contarCola(
      this.envios,
      copropiedadId,
      ahora,
    );
    resultado.pendientes = pendientes;
    resultado.enCurso = enCurso;
    resultado.enEspera = enEspera;
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
   * `liberadaEn` is NOT stamped here but per row in `entregarFila`, once the
   * invoice is known to be still `emitida` (see `liberar`).
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
    const [residentes, destinos] = await Promise.all([
      this.directorio.residentesDeInmuebles(copropiedadId, unidades),
      this.directorio.correosDeInmuebles(copropiedadId, unidades),
    ]);
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
      destinos,
      // Validated by `procesarPendientes` before anything was claimed.
      frontendUrl: this.config.get<string>('app.frontendUrl')!.trim(),
    };

    const inicio = Date.now();
    for (let i = 0; i < filas.length; i += ENVIOS_SIMULTANEOS) {
      // Out of time: stop STARTING work and answer; the rest is released and the
      // screen calls again.
      if (Date.now() - inicio > PRESUPUESTO_MS) return;
      // Only the rows this call STILL holds: if a batch stalled past the lease,
      // another processor may have taken some of the rest, and sending to them
      // too would widen the overlap beyond the one batch Ruling 10 accepts.
      const tanda = filas.slice(i, i + ENVIOS_SIMULTANEOS);
      const propias = await this.filasPropias(copropiedadId, token, tanda);
      if (propias.size === 0) return;
      const resultados = await Promise.all(
        tanda
          .filter((fila) => propias.has(fila._id.toString()))
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
      await this.liberar(fila, contexto);

      const cuentas = this.sinRepetidos(
        contexto.residentes.get(fila.inmuebleId.toString()) ?? [],
      );
      const destinos = contexto.destinos.get(fila.inmuebleId.toString()) ?? [];

      // In-app notices first (idempotent per account), whether or not the unit
      // has any address: linked accounts keep their notice.
      const notificados = new Set(fila.notificadosIds.map(String));
      for (const cuenta of cuentas) {
        await this.notificar(fila, cuenta, factura, contexto, notificados);
      }

      if (destinos.length === 0) {
        const r = await this.cerrarConError(
          fila,
          contexto,
          'sin_destinatarios',
        );
        return { ...r, sinDestinatario: fila.codigoInmueble };
      }

      const entregadas = new Set(
        (fila.correosEntregados ?? []).map((e) => e.clave),
      );
      let correos = 0;
      for (const destino of destinos) {
        if (entregadas.has(destino.clave)) continue;
        if (await this.enviarA(fila, destino, factura, contexto)) {
          entregadas.add(destino.clave);
          correos += 1;
        }
      }

      const completo =
        cuentas.every((c) => notificados.has(c.accountId)) &&
        destinos.every((d) => entregadas.has(d.clave));
      if (completo) {
        await this.cerrarEnviada(fila, contexto, destinos.length);
        return { tipo: 'enviada', correos };
      }
      return {
        ...(await this.cerrarConFallo(fila, contexto, destinos.length)),
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
   * The in-app notice of one linked account (if missing). Never throws; a notice
   * that could not be stored simply stays unrecorded and pending.
   */
  private async notificar(
    fila: EnvioFacturaDocument,
    cuenta: ResidenteDeInmueble,
    factura: { numeroCompleto: string },
    contexto: ContextoProceso,
    notificados: Set<string>,
  ): Promise<void> {
    if (notificados.has(cuenta.accountId)) return;
    // Account id, never the address: the log is not a place for personal data.
    const etiqueta = `${fila._id.toString()} a la cuenta ${cuenta.accountId}`;
    try {
      const guardada = await this.notificaciones.crear({
        copropiedadId: contexto.copropiedadId,
        accountId: cuenta.accountId,
        tipo: 'pago',
        titulo: construirAsuntoFactura(factura.numeroCompleto),
      });
      // Not stored = still pending: the row is retried, never faked as sent.
      if (!guardada) return;
      await this.envios
        .updateOne(
          { _id: fila._id, copropiedadId: contexto.copropiedadId },
          {
            $addToSet: { notificadosIds: new Types.ObjectId(cuenta.accountId) },
          },
        )
        .exec();
      notificados.add(cuenta.accountId);
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo avisar a ${etiqueta}: ${(error as Error).name}`,
      );
    }
  }

  /**
   * One ADDRESS of the record: mints its own link, sends its own e-mail and
   * records the acceptance. Answers whether the provider accepted it. Never
   * throws, and logs only the row id, the link id and the role: never the
   * address, the token or its hash (an error's class name is logged, not its
   * message, which could echo a filter or a key).
   *
   * A refused or failed send revokes the link it just minted (best effort), so no
   * credential outlives an e-mail that never left. After an ACCEPTED send the
   * link is never revoked, even if recording it fails: the e-mail is out and
   * carries it (the retry may e-mail that address once more, the accepted
   * trade-off in the class docblock).
   */
  private async enviarA(
    fila: EnvioFacturaDocument,
    destino: DestinoCorreo,
    factura: { numeroCompleto: string; periodoDesde?: Date },
    contexto: ContextoProceso,
  ): Promise<boolean> {
    const etiquetaFila = fila._id.toString();
    let enlaceId: string | null = null;
    let aceptado = false;
    try {
      const enlace = await this.enlaces.emitir({
        copropiedadId: contexto.copropiedadId,
        facturaId: fila.facturaId,
        envioFacturaId: fila._id,
        clave: destino.clave,
        rol: destino.rol,
      });
      enlaceId = enlace.id;
      const { asunto, html } = construirCorreoFactura({
        nombreDestinatario: destino.nombre,
        nombreCopropiedad: contexto.nombreCopropiedad,
        numeroCompleto: factura.numeroCompleto,
        codigoInmueble: fila.codigoInmueble,
        periodo: etiquetaPeriodo(factura.periodoDesde),
        enlacePdf: construirEnlacePdf(contexto.frontendUrl, enlace.token),
        venceEl: etiquetaFechaVencimiento(enlace.expiraEn),
        urlPortal: construirUrlPortal(contexto.frontendUrl),
      });
      aceptado = await this.correo.enviar({
        para: destino.email,
        asunto,
        html,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo preparar la factura ${etiquetaFila} (${destino.rol}): ${error instanceof Error ? error.name : 'desconocido'}`,
      );
    }

    if (!aceptado) {
      if (enlaceId) {
        this.logger.error(
          `No se pudo enviar la factura ${etiquetaFila} (enlace ${enlaceId}, ${destino.rol}).`,
        );
        await this.revocarSinFallar(contexto, enlaceId);
      }
      return false;
    }

    try {
      await this.registrarEntrega(fila, destino, contexto);
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo anotar la entrega de ${etiquetaFila} (enlace ${enlaceId}, ${destino.rol}): ${error instanceof Error ? error.name : 'desconocido'}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Records one address as reached. Conditional on the `clave` not being there
   * yet, so two processors accepting the same address leave ONE entry (a plain
   * `$addToSet` would not: `aceptadoEn` makes each subdocument unique). The
   * entry holds the `clave`, never the address.
   */
  private async registrarEntrega(
    fila: EnvioFacturaDocument,
    destino: DestinoCorreo,
    contexto: ContextoProceso,
  ): Promise<void> {
    await this.envios
      .updateOne(
        {
          _id: fila._id,
          copropiedadId: contexto.copropiedadId,
          'correosEntregados.clave': { $ne: destino.clave },
        },
        {
          $push: {
            correosEntregados: {
              clave: destino.clave,
              rol: destino.rol,
              terceroId: destino.terceroId,
              aceptadoEn: new Date(),
            },
          },
        },
      )
      .exec();
  }

  /** Best-effort revocation of a link whose e-mail was not accepted. */
  private async revocarSinFallar(
    contexto: ContextoProceso,
    enlaceId: string,
  ): Promise<void> {
    try {
      await this.enlaces.revocarPorId(contexto.copropiedadId, enlaceId);
    } catch {
      this.logger.error(`No se pudo revocar el enlace ${enlaceId}.`);
    }
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

  /**
   * Makes the invoice visible in the portal (Ruling 6), before its first
   * notice goes out so the emailed link never lands on a 404. Done per row,
   * AFTER the invoice was found still `emitida`: an invoice voided after it was
   * marked is never released. `$min` keeps the first stamp; the token in the
   * filter means only the current holder can stamp.
   */
  private async liberar(
    fila: EnvioFacturaDocument,
    contexto: ContextoProceso,
  ): Promise<void> {
    await this.envios
      .updateOne(
        {
          _id: fila._id,
          copropiedadId: contexto.copropiedadId,
          tokenEnvio: contexto.token,
        },
        { $min: { liberadaEn: new Date() } },
      )
      .exec();
  }

  /** Ids (as strings) of the given rows that still carry this call's token. */
  private async filasPropias(
    copropiedadId: Types.ObjectId,
    token: string,
    filas: EnvioFacturaDocument[],
  ): Promise<Set<string>> {
    const propias = await this.envios
      .find({
        copropiedadId,
        tokenEnvio: token,
        _id: { $in: filas.map((f) => f._id) },
      })
      .select('_id')
      .lean()
      .exec();
    return new Set(propias.map((f) => String(f._id)));
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
