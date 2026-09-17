import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ResultadoReinicioCiclo } from '../../contracts';

/**
 * The ONE coproperty this operation is allowed to touch, hardcoded on
 * purpose — never read from config, never overridable per-request. This is
 * the demo/sandbox building used to show prospective clients the billing
 * cycle end to end; it is never where real customer data lives.
 */
const CODIGO_COPROPIEDAD_PRUEBA = '0001';

/**
 * Wipes EVERY financial document of the one hardcoded test coproperty —
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
 * A stray `LoteRecibos` left in `borrador`/`cargado` state is not merely
 * clutter: `LoteRecibosSchema`'s own partial unique index allows at most one
 * such batch per coproperty, so leaving one behind blocks starting a new
 * Recibos-por-lote upload after the reset — the exact bug this reset exists
 * to prevent.
 *
 * This is a deliberate, narrow exception to "nothing financial is ever
 * deleted" (see backend/CLAUDE.md's audit law) — never a template for
 * anything else. Three independent guards keep it from ever touching real
 * data: (1) the hardcoded coproperty-code check below, enforced here
 * regardless of who holds the permission or which building is active on the
 * caller's screen; (2) the `CicloFacturacionPrueba`/`reiniciar` CASL pair,
 * which is its own subject/action, never `Factura`'s; (3) the frontend's
 * own type-to-confirm step. Losing any one of the three still leaves the
 * other two standing.
 */
@Injectable()
export class ReiniciarCicloService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
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
    private readonly tenant: TenantContextService,
  ) {}

  async reiniciar(): Promise<ResultadoReinicioCiclo> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap.
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad || copropiedad.code !== CODIGO_COPROPIEDAD_PRUEBA) {
      throw new ForbiddenException(
        'Esta operación solo está disponible en la copropiedad de pruebas.',
      );
    }

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
    ] = await Promise.all([
      this.aplicaciones.deleteMany({ coPropertyId }).exec(),
      this.notasCredito.deleteMany({ coPropertyId }).exec(),
      this.notasDebito.deleteMany({ coPropertyId }).exec(),
      this.notasAnticipo.deleteMany({ coPropertyId }).exec(),
      this.notasContables.deleteMany({ coPropertyId }).exec(),
      this.recibos.deleteMany({ coPropertyId }).exec(),
      this.loteRecibos.deleteMany({ coPropertyId }).exec(),
      this.lotesContabilidad.deleteMany({ coPropertyId }).exec(),
      this.saldosIniciales.deleteMany({ coPropertyId }).exec(),
      this.lotesSaldoInicial.deleteMany({ coPropertyId }).exec(),
      this.saldosInicialesAnticipo.deleteMany({ coPropertyId }).exec(),
      this.lotesSaldoInicialAnticipo.deleteMany({ coPropertyId }).exec(),
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
      this.asientos.deleteMany({ coPropertyId }).exec(),
      this.saldos.deleteMany({ coPropertyId }).exec(),
      // Unfiltered by tipoDocumento on purpose — its FV/ND/SI rows are ALL
      // orphaned by this same reset (their anchor documents are wiped
      // above/below), so all three go together.
      this.carteraPorDocumento.deleteMany({ coPropertyId }).exec(),
      this.saldosDocumentoOrigen.deleteMany({ coPropertyId }).exec(),
      this.saldoTotalDocumento.deleteMany({ coPropertyId }).exec(),
    ]);

    const facturasEliminadas = await this.facturas
      .deleteMany({ coPropertyId })
      .exec();
    const lotesEliminados = await this.lotes
      .deleteMany({ coPropertyId })
      .exec();

    // 0, not 1: siguienteLote/siguienteDocumento increment BEFORE reading
    // (`{ returnDocument: 'after' }`), so a row left at 1 would hand out 2 as the first
    // number after reset. 0 is what a brand-new row starts at (missing
    // field + $inc on upsert), so the next call returns 1.
    await this.consecutivoLote
      .updateOne({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    // Every code this coproperty has configured (RC, NC, ND, NA, ...), not
    // just one — every document type is wiped above, so every counter must
    // restart together.
    await this.consecutivoDocumento
      .updateMany({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    // LoteRecibos has its own consecutivo, separate from consecutivoDocumento
    // (its numbers are internal to the batch, never a document type code).
    await this.consecutivoLoteRecibos
      .updateOne({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    // Same reasoning as consecutivoLoteRecibos above — "Adición a
    // Contabilidad" has its own independent batch sequence.
    await this.consecutivoLoteContabilidad
      .updateOne({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    // Same reasoning again — Saldos Iniciales numbers off its own internal
    // ordinal (ConsecutivoSaldoInicial), never ConsecutivoDocumento.
    await this.consecutivoSaldoInicial
      .updateOne({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    // Same reasoning again — Saldos Iniciales de Anticipo has its own
    // independent ordinal, separate from ConsecutivoSaldoInicial (cargos and
    // anticipos are two different document collections).
    await this.consecutivoSaldoInicialAnticipo
      .updateOne({ coPropertyId }, { $set: { nextNumber: 0 } })
      .exec();
    const resolucionActiva = await this.resoluciones
      .findOne({ coPropertyId, status: 'active' })
      .exec();
    if (resolucionActiva) {
      await this.resoluciones
        .updateOne(
          { _id: resolucionActiva._id },
          { $set: { nextNumber: resolucionActiva.rangeFrom } },
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
    };
  }
}
