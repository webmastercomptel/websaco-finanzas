import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  SaldoDocumentoOrigen,
  SaldoDocumentoOrigenDocument,
} from '../../database/schemas/recibos/saldo-documento-origen.schema';
import {
  ConsecutivoLote,
  ConsecutivoLoteDocument,
} from '../../database/schemas/facturacion/consecutivo-lote.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  LoteRecibos,
  LoteRecibosDocument,
} from '../../database/schemas/recibos/lote-recibos.schema';
import {
  ConsecutivoLoteRecibos,
  ConsecutivoLoteRecibosDocument,
} from '../../database/schemas/recibos/consecutivo-lote-recibos.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  LoteContabilidad,
  LoteContabilidadDocument,
} from '../../database/schemas/contabilidad/lote-contabilidad.schema';
import {
  ConsecutivoLoteContabilidad,
  ConsecutivoLoteContabilidadDocument,
} from '../../database/schemas/contabilidad/consecutivo-lote-contabilidad.schema';
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import {
  LoteSaldoInicial,
  LoteSaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/lote-saldo-inicial.schema';
import {
  ConsecutivoSaldoInicial,
  ConsecutivoSaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/consecutivo-saldo-inicial.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import {
  SaldoInicialAnticipo,
  SaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import {
  LoteSaldoInicialAnticipo,
  LoteSaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/lote-saldo-inicial-anticipo.schema';
import {
  ConsecutivoSaldoInicialAnticipo,
  ConsecutivoSaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/consecutivo-saldo-inicial-anticipo.schema';
import {
  PresentacionDocumento,
  PresentacionDocumentoDocument,
} from '../../database/schemas/documentos/presentacion-documento.schema';
import {
  ProgresoImportacion,
  ProgresoImportacionDocument,
  type TipoImportacion,
} from '../../database/schemas/importaciones/progreso-importacion.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import { prefijoDocumentosGenerados } from '../../common/documentos/prefijo-documentos-generados';
import { escapeRegex } from '../../common/utils/query.utils';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  NOMBRE_COLA_APLICACION_LOTE_RECIBOS,
  type DatosTrabajoAplicacionLoteRecibos,
  type ResultadoAplicacionLoteRecibos,
} from '../recibos/colas/aplicacion-lote-recibos.constants';
import type { ResultadoReinicioCiclo } from '../../contracts';

/** The only two bulk-import progress rows that belong to this reset: the
 *  saldos-iniciales imports are financial data this service wipes; the
 *  inmuebles / valores-recurrentes imports are catalog data it does not touch,
 *  so their progress rows are left alone. */
const TIPOS_IMPORTACION_FINANCIERA: TipoImportacion[] = [
  'saldos-iniciales',
  'saldos-iniciales-anticipo',
];

/** BullMQ states in which an application job has been accepted but has not
 *  finished — i.e. it may still write Recibos/Asientos/Saldos. */
const ESTADOS_TRABAJO_EN_CURSO = [
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
] as const;

/** A saldos-iniciales `ProgresoImportacion` row is upserted while an import
 *  runs and deleted when it ends, so a RECENT row means "running". A crashed
 *  import never removes its row, hence an older row is treated as stale — it
 *  is wiped like before instead of blocking the reset forever. */
const VENTANA_IMPORTACION_EN_CURSO_MS = 15 * 60 * 1000;

const ETIQUETA_IMPORTACION: Partial<Record<TipoImportacion, string>> = {
  'saldos-iniciales': 'Saldos Iniciales',
  'saldos-iniciales-anticipo': 'Saldos Iniciales de Anticipo',
};

/** Error text safe to log/audit: the message only, never the object (which
 *  may carry connection strings or request details). */
const mensajeDe = (err: unknown): string =>
  err instanceof Error ? err.message : 'error desconocido';

/**
 * Wipes EVERY financial document of the ACTIVE coproperty —
 * Lotes/Facturas, Recibos (and their own Lotes de Recibos batch uploads),
 * Notas Crédito/Débito/Anticipo/Contables, Saldos Iniciales de cargo AND de
 * anticipo (and their own, independent Lotes batch uploads), everything they
 * moved (AplicacionCartera, asientos contables, SaldoCartera, and the three
 * per-document cartera ledgers — `CarteraPorDocumento`,
 * `SaldoDocumentoOrigen`, `SaldoTotalDocumento`), and every past "Adición a
 * Contabilidad" export (`LoteContabilidad`) — and rewinds
 * every document's numbering back to zero, so the whole billing cycle can be
 * replayed from a blank slate as many times as needed. Nothing is left
 * half-deleted for a caller to clean up by hand: every document type this
 * system knows how to issue is wiped together, so there is never a leftover
 * Recibo/Nota/Saldo Inicial pointing at a Factura that no longer exists.
 *
 * Also wiped, because they only make sense next to the documents above:
 *  - `PresentacionDocumento` — the pointers to the generated PDFs. That
 *    collection has NO `copropiedadId`, so it is matched by the anchored
 *    `objectPath` prefix of this coproperty (`prefijoDocumentosGenerados`),
 *    never by a tenant filter (which would silently match nothing).
 *  - `ProgresoImportacion` rows of the two saldos-iniciales imports only.
 *  - The generated PDF files themselves in object storage (same prefix),
 *    BEST-EFFORT: Mongo is already wiped when storage is touched, so a storage
 *    failure is logged and reported as 0 files deleted
 *    (`archivosPdfEliminados`) instead of failing a request whose main work
 *    already happened.
 *
 * Concurrency guard: it REFUSES (`ConflictException`, before deleting
 * anything) while a long-running job of this coproperty is in flight, since
 * that job would keep writing Facturas/Asientos/Saldos after the wipe — a
 * consolidación (`LoteFacturacion.progreso` non-null) or a Recibos-por-lote
 * application (an unfinished BullMQ job in the aplicación queue;
 * `LoteRecibos` carries no persisted in-progress marker) or a saldos-iniciales
 * import (a RECENT `ProgresoImportacion` row — older rows are stale leftovers
 * of a crashed import and are wiped, not honoured). Only these long-running
 * jobs are covered; see "Known residual risk" below.
 *
 * Audit: after a successful wipe it writes ONE `AuditoriaService` entry
 * (`accion: 'reiniciar'`, `entidadTipo: 'copropiedad'`) carrying the counts.
 * If a delete/rewind step fails midway, ONE entry marked as a PARTIAL reset
 * is written instead (best-effort) and the original error is rethrown. The
 * wipe is never undone if an audit write fails — it is logged instead.
 *
 * Known residual risk: the guard-then-delete sequence is NOT atomic, and
 * ordinary writes (a single Recibo, Nota, Factura Individual) are never
 * locked out, so run it when nobody is issuing documents. `PublicacionLote`
 * (the outbox to the other system) is deliberately NOT handled yet because
 * that integration is not in use; it must be revisited before it is
 * enabled, since rewound invoice numbers would be republished.
 *
 * A stray `LoteRecibos` left in `borrador`/`cargado` state is not merely
 * clutter: `LoteRecibosSchema`'s own partial unique index allows at most one
 * such batch per coproperty, so leaving one behind blocks starting a new
 * Recibos-por-lote upload after the reset — the exact bug this reset exists
 * to prevent.
 *
 * This is a deliberate, narrow exception to "nothing financial is ever
 * deleted" (see backend/CLAUDE.md's audit law) — never a template for
 * anything else.
 *
 * It used to be restricted to the 0001-0003 sandbox coproperties by a
 * hardcoded whitelist; that restriction was removed on purpose (product
 * owner, 2026-10-09), so it now works on ANY coproperty, real clients
 * included. What keeps it from being misused is who can call it —
 * `PlatformAdminGuard` on the controller, with no CASL permission a
 * customer's administrator could be granted — plus the frontend's
 * type-to-confirm step. The service itself holds no guard: the tenant comes
 * from the request context like every other query here.
 */
@Injectable()
export class ReiniciarCicloService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(SaldoDocumentoOrigen.name)
    private readonly saldosDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
    @InjectModel(ConsecutivoLote.name)
    private readonly consecutivoLote: Model<ConsecutivoLoteDocument>,
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivoDocumento: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(LoteRecibos.name)
    private readonly loteRecibos: Model<LoteRecibosDocument>,
    @InjectModel(ConsecutivoLoteRecibos.name)
    private readonly consecutivoLoteRecibos: Model<ConsecutivoLoteRecibosDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(LoteContabilidad.name)
    private readonly lotesContabilidad: Model<LoteContabilidadDocument>,
    @InjectModel(ConsecutivoLoteContabilidad.name)
    private readonly consecutivoLoteContabilidad: Model<ConsecutivoLoteContabilidadDocument>,
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales: Model<SaldoInicialDocument>,
    @InjectModel(LoteSaldoInicial.name)
    private readonly lotesSaldoInicial: Model<LoteSaldoInicialDocument>,
    @InjectModel(ConsecutivoSaldoInicial.name)
    private readonly consecutivoSaldoInicial: Model<ConsecutivoSaldoInicialDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
    @InjectModel(SaldoInicialAnticipo.name)
    private readonly saldosInicialesAnticipo: Model<SaldoInicialAnticipoDocument>,
    @InjectModel(LoteSaldoInicialAnticipo.name)
    private readonly lotesSaldoInicialAnticipo: Model<LoteSaldoInicialAnticipoDocument>,
    @InjectModel(ConsecutivoSaldoInicialAnticipo.name)
    private readonly consecutivoSaldoInicialAnticipo: Model<ConsecutivoSaldoInicialAnticipoDocument>,
    @InjectModel(PresentacionDocumento.name)
    private readonly presentaciones: Model<PresentacionDocumentoDocument>,
    @InjectModel(ProgresoImportacion.name)
    private readonly progresosImportacion: Model<ProgresoImportacionDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly storage: DocumentoStorageService,
    private readonly auditoria: AuditoriaService,
    @InjectQueue(NOMBRE_COLA_APLICACION_LOTE_RECIBOS)
    private readonly colaAplicacionLoteRecibos: Queue<
      DatosTrabajoAplicacionLoteRecibos,
      ResultadoAplicacionLoteRecibos
    >,
    private readonly tenant: TenantContextService,
  ) {}

  private readonly logger = new Logger(ReiniciarCicloService.name);

  /**
   * @param accountId the platform administrator running the reset, recorded
   *   as the actor of the audit entry.
   */
  async reiniciar(accountId: string): Promise<ResultadoReinicioCiclo> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // Every guard runs before ANY write.
    await this.exigirSinTrabajosEnCurso(copropiedadId);

    let borrado: Omit<ResultadoReinicioCiclo, 'archivosPdfEliminados'>;
    try {
      borrado = await this.borrarYReiniciar(copropiedadId);
    } catch (err) {
      // Some documents may already be gone while others (and the counters)
      // are not: leave a trace of the half-done reset, then surface the
      // ORIGINAL error — the audit write must never mask it.
      await this.registrarAuditoriaParcial(accountId, copropiedadId, err);
      throw err;
    }

    // Last, and best-effort: Mongo is already wiped, so failing the request
    // here would report an error for a reset that happened. The orphaned PDFs
    // are then merely unreachable (their pointers are gone), never wrong data.
    let archivosPdfEliminados = 0;
    let almacenamientoLimpio = true;
    try {
      const { eliminados, fallidos } = await this.storage.eliminarPrefijo(
        prefijoDocumentosGenerados(copropiedadId),
      );
      archivosPdfEliminados = eliminados;
      if (fallidos > 0) {
        almacenamientoLimpio = false;
        this.logger.warn(
          `Reinicio de ciclo ${copropiedadId.toString()}: ${fallidos} archivo(s) PDF no se pudieron borrar del almacenamiento (${eliminados} sí).`,
        );
      }
    } catch (err) {
      almacenamientoLimpio = false;
      this.logger.warn(
        `Reinicio de ciclo ${copropiedadId.toString()}: no se pudieron borrar los PDF del almacenamiento (${mensajeDe(err)}).`,
      );
    }

    const resultado: ResultadoReinicioCiclo = {
      ...borrado,
      archivosPdfEliminados,
    };

    await this.registrarAuditoria(
      accountId,
      copropiedadId,
      resultado,
      almacenamientoLimpio,
    );

    return resultado;
  }

  /**
   * The destructive section: every Mongo delete and counter rewind, in
   * order. Split out so `reiniciar` can audit a failure in the middle of it.
   */
  private async borrarYReiniciar(
    copropiedadId: Types.ObjectId,
  ): Promise<Omit<ResultadoReinicioCiclo, 'archivosPdfEliminados'>> {
    const prefijoPdfs = prefijoDocumentosGenerados(copropiedadId);

    // Every financial document type wiped together — no cross-reference
    // guard needed anymore, since nothing survives that could point at a
    // deleted Factura/Recibo.
    const [
      aplicacionesEliminadas,
      notasCreditoEliminadas,
      notasDebitoEliminadas,
      notasAnticipoEliminadas,
      notasContablesEliminadas,
      recibosEliminados,
      loteRecibosEliminados,
      lotesContabilidadEliminados,
      saldosInicialesEliminados,
      lotesSaldoInicialEliminados,
      saldosInicialesAnticipoEliminados,
      lotesSaldoInicialAnticipoEliminados,
      presentacionesEliminadas,
      progresosImportacionEliminados,
    ] = await Promise.all([
      this.aplicaciones.deleteMany({ copropiedadId }).exec(),
      this.notasCredito.deleteMany({ copropiedadId }).exec(),
      this.notasDebito.deleteMany({ copropiedadId }).exec(),
      this.notasAnticipo.deleteMany({ copropiedadId }).exec(),
      this.notasContables.deleteMany({ copropiedadId }).exec(),
      this.recibos.deleteMany({ copropiedadId }).exec(),
      this.loteRecibos.deleteMany({ copropiedadId }).exec(),
      this.lotesContabilidad.deleteMany({ copropiedadId }).exec(),
      this.saldosIniciales.deleteMany({ copropiedadId }).exec(),
      this.lotesSaldoInicial.deleteMany({ copropiedadId }).exec(),
      this.saldosInicialesAnticipo.deleteMany({ copropiedadId }).exec(),
      this.lotesSaldoInicialAnticipo.deleteMany({ copropiedadId }).exec(),
      // `PresentacionDocumento` has no `copropiedadId`: a tenant filter would
      // match nothing. Its rows are found by the (anchored, escaped) storage
      // prefix every path of this coproperty starts with. Lote-level PDFs
      // (anchored on a lote `_id`) live under the same prefix.
      this.presentaciones
        .deleteMany({
          objectPath: { $regex: `^${escapeRegex(prefijoPdfs)}` },
        })
        .exec(),
      this.progresosImportacion
        .deleteMany({
          copropiedadId,
          tipo: { $in: TIPOS_IMPORTACION_FINANCIERA },
        })
        .exec(),
    ]);

    const [
      asientosEliminados,
      saldosEliminados,
      carteraPorDocumentoEliminada,
      saldosDocumentoOrigenEliminados,
      saldoTotalDocumentoEliminado,
    ] = await Promise.all([
      // Every asiento, regardless of anchor (Factura/Recibo/NC/ND/NT/NA) —
      // every one of those anchors is wiped above too.
      this.asientos.deleteMany({ copropiedadId }).exec(),
      this.saldos.deleteMany({ copropiedadId }).exec(),
      // Unfiltered by tipoDocumento on purpose — its FV/ND/SI rows are ALL
      // orphaned by this same reset (their anchor documents are wiped
      // above/below), so all three go together.
      this.carteraPorDocumento.deleteMany({ copropiedadId }).exec(),
      this.saldosDocumentoOrigen.deleteMany({ copropiedadId }).exec(),
      this.saldoTotalDocumento.deleteMany({ copropiedadId }).exec(),
    ]);

    const facturasEliminadas = await this.facturas
      .deleteMany({ copropiedadId })
      .exec();
    const lotesEliminados = await this.lotes
      .deleteMany({ copropiedadId })
      .exec();

    // 0, not 1: siguienteLote/siguienteDocumento increment BEFORE reading
    // (`{ returnDocument: 'after' }`), so a row left at 1 would hand out 2 as the first
    // number after reset. 0 is what a brand-new row starts at (missing
    // field + $inc on upsert), so the next call returns 1.
    await this.consecutivoLote
      .updateOne({ copropiedadId }, { $set: { siguienteNumero: 0 } })
      .exec();
    // Every code this coproperty has configured (RC, NC, ND, NA, ...), not
    // just one — every document type is wiped above, so every counter must
    // restart together.
    await this.consecutivoDocumento
      .updateMany({ copropiedadId }, { $set: { siguienteNumero: 0 } })
      .exec();
    // LoteRecibos has its own consecutivo, separate from consecutivoDocumento
    // (its numbers are internal to the batch, never a document type code).
    await this.consecutivoLoteRecibos
      .updateOne({ copropiedadId }, { $set: { siguienteNumero: 0 } })
      .exec();
    // Same reasoning as consecutivoLoteRecibos above — "Adición a
    // Contabilidad" has its own independent batch sequence.
    await this.consecutivoLoteContabilidad
      .updateOne({ copropiedadId }, { $set: { nextNumber: 0 } })
      .exec();
    // Same reasoning again — Saldos Iniciales numbers off its own internal
    // ordinal (ConsecutivoSaldoInicial), never ConsecutivoDocumento.
    await this.consecutivoSaldoInicial
      .updateOne({ copropiedadId }, { $set: { siguienteNumero: 0 } })
      .exec();
    // Same reasoning again — Saldos Iniciales de Anticipo has its own
    // independent ordinal, separate from ConsecutivoSaldoInicial (cargos and
    // anticipos are two different document collections).
    await this.consecutivoSaldoInicialAnticipo
      .updateOne({ copropiedadId }, { $set: { siguienteNumero: 0 } })
      .exec();
    const resolucionActiva = await this.resoluciones
      .findOne({ copropiedadId, estado: 'active' })
      .exec();
    if (resolucionActiva) {
      await this.resoluciones
        .updateOne(
          { _id: resolucionActiva._id },
          { $set: { siguienteNumero: resolucionActiva.rangoDesde } },
        )
        .exec();
    }

    return {
      lotesEliminados: lotesEliminados.deletedCount,
      facturasEliminadas: facturasEliminadas.deletedCount,
      recibosEliminados: recibosEliminados.deletedCount,
      loteRecibosEliminados: loteRecibosEliminados.deletedCount,
      notasCreditoEliminadas: notasCreditoEliminadas.deletedCount,
      notasDebitoEliminadas: notasDebitoEliminadas.deletedCount,
      notasAnticipoEliminadas: notasAnticipoEliminadas.deletedCount,
      notasContablesEliminadas: notasContablesEliminadas.deletedCount,
      aplicacionesEliminadas: aplicacionesEliminadas.deletedCount,
      asientosEliminados: asientosEliminados.deletedCount,
      saldosEliminados: saldosEliminados.deletedCount,
      carteraPorDocumentoEliminada: carteraPorDocumentoEliminada.deletedCount,
      saldosDocumentoOrigenEliminados:
        saldosDocumentoOrigenEliminados.deletedCount,
      lotesContabilidadEliminados: lotesContabilidadEliminados.deletedCount,
      saldosInicialesEliminados: saldosInicialesEliminados.deletedCount,
      lotesSaldoInicialEliminados: lotesSaldoInicialEliminados.deletedCount,
      saldoTotalDocumentoEliminado: saldoTotalDocumentoEliminado.deletedCount,
      saldosInicialesAnticipoEliminados:
        saldosInicialesAnticipoEliminados.deletedCount,
      lotesSaldoInicialAnticipoEliminados:
        lotesSaldoInicialAnticipoEliminados.deletedCount,
      presentacionesEliminadas: presentacionesEliminadas.deletedCount,
      progresosImportacionEliminados:
        progresosImportacionEliminados.deletedCount,
    };
  }

  /**
   * Refuses to run while a long-running job of this coproperty is in flight:
   * it would keep creating Facturas/Asientos/Saldos AFTER the wipe, leaving
   * the "blank slate" half-populated. Runs before anything is deleted.
   *
   * - Consolidación: `LoteFacturacion.progreso` is non-null while a run holds
   *   the claim (set at claim time, cleared at the end of the run). A claim
   *   whose worker died stays non-null until someone takes it over, so this
   *   errs on the side of refusing.
   * - Aplicación de un lote de recibos: `LoteRecibos` has NO in-progress
   *   field — the lote stays `cargado` while the job runs. The only real
   *   marker is the BullMQ job itself, so the aplicación queue is inspected
   *   for an unfinished job carrying this `copropiedadId`.
   */
  private async exigirSinTrabajosEnCurso(
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    const consolidando = await this.lotes
      .findOne({ copropiedadId, progreso: { $ne: null } })
      .exec();
    if (consolidando) {
      throw new ConflictException(
        'No se puede reiniciar el ciclo: hay una consolidación de facturas en curso. Esperá a que termine e intentá de nuevo.',
      );
    }

    const trabajos = await this.colaAplicacionLoteRecibos.getJobs([
      ...ESTADOS_TRABAJO_EN_CURSO,
    ]);
    const aplicando = trabajos.some(
      (trabajo) => trabajo.data.copropiedadId === copropiedadId.toString(),
    );
    if (aplicando) {
      throw new ConflictException(
        'No se puede reiniciar el ciclo: hay un lote de recibos aplicándose. Esperá a que termine e intentá de nuevo.',
      );
    }

    // A saldos-iniciales import keeps writing Saldos/Asientos after the wipe.
    // Its progress row exists only while it runs; an old row is a crashed
    // import's leftover, so it does not count (and is wiped afterwards).
    const importando = await this.progresosImportacion
      .findOne({
        copropiedadId,
        tipo: { $in: TIPOS_IMPORTACION_FINANCIERA },
        updatedAt: {
          $gte: new Date(Date.now() - VENTANA_IMPORTACION_EN_CURSO_MS),
        },
      })
      .exec();
    if (importando) {
      throw new ConflictException(
        `No se puede reiniciar el ciclo: hay una importación de ${ETIQUETA_IMPORTACION[importando.tipo] ?? importando.tipo} en curso. Esperá a que termine e intentá de nuevo.`,
      );
    }
  }

  /**
   * Audit entry for a reset that failed AFTER the guards passed: some
   * documents may already be gone. Best-effort and silent by contract — it
   * runs while the original error is about to be rethrown and must never
   * replace it. Only the error message goes in (no objects, no secrets).
   */
  private async registrarAuditoriaParcial(
    accountId: string,
    copropiedadId: Types.ObjectId,
    causa: unknown,
  ): Promise<void> {
    try {
      const [cuenta, copropiedad] = await Promise.all([
        this.cuentas.findById(accountId).exec(),
        this.copropiedades.findById(copropiedadId).exec(),
      ]);
      const copropiedadEtiqueta =
        [copropiedad?.codigo, copropiedad?.nombre].filter(Boolean).join(' ') ||
        copropiedadId.toString();
      await this.auditoria.registrar({
        actorAccountId: accountId,
        actorNombre: cuenta?.nombreCompleto ?? 'Administrador de plataforma',
        accion: 'reiniciar',
        entidadTipo: 'copropiedad',
        entidadId: copropiedadId.toString(),
        entidadEtiqueta: `Reinicio PARCIAL en ${copropiedadEtiqueta} — falló: ${mensajeDe(causa)}`,
      });
    } catch (err) {
      this.logger.error(
        `Reinicio de ${copropiedadId.toString()} falló a medias y tampoco se pudo registrar en auditoría: ${mensajeDe(err)}`,
      );
    }
  }

  /**
   * One audit entry for the reset itself. Best-effort by design: the wipe is
   * irreversible, so a failure to log it is reported loudly but never
   * rejects the request (same trade-off as `LotesFacturacionService`'s
   * reversal entry). `EntradaAuditoria` has no payload field, so the counts
   * travel in the human-readable label.
   */
  private async registrarAuditoria(
    accountId: string,
    copropiedadId: Types.ObjectId,
    resultado: ResultadoReinicioCiclo,
    almacenamientoLimpio: boolean,
  ): Promise<void> {
    try {
      const [cuenta, copropiedad] = await Promise.all([
        this.cuentas.findById(accountId).exec(),
        this.copropiedades.findById(copropiedadId).exec(),
      ]);
      const copropiedadEtiqueta =
        [copropiedad?.codigo, copropiedad?.nombre].filter(Boolean).join(' ') ||
        copropiedadId.toString();
      const conteos = Object.entries(resultado)
        .filter(([, cantidad]) => cantidad > 0)
        .map(([clave, cantidad]) => `${clave}: ${cantidad}`)
        .join(', ');
      const nota = almacenamientoLimpio
        ? ''
        : ' (los archivos PDF NO se pudieron borrar del almacenamiento)';

      await this.auditoria.registrar({
        actorAccountId: accountId,
        actorNombre: cuenta?.nombreCompleto ?? 'Administrador de plataforma',
        accion: 'reiniciar',
        entidadTipo: 'copropiedad',
        entidadId: copropiedadId.toString(),
        entidadEtiqueta: `Ciclo reiniciado en ${copropiedadEtiqueta}: ${conteos || 'sin documentos que eliminar'}${nota}`,
      });
    } catch (err) {
      this.logger.error(
        `Ciclo de ${copropiedadId.toString()} reiniciado pero no se pudo registrar en auditoría: ${mensajeDe(err)}`,
      );
    }
  }
}
