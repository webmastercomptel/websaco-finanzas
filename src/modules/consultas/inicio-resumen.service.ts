import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { MontoPorConcepto, RespuestaInicioResumen } from '../../contracts';

const RESUMEN_VACIO: RespuestaInicioResumen = {
  periodo: null,
  totalFacturado: 0,
  facturadoPorConcepto: [],
  totalIngresosRecibidos: 0,
  recibidoPorConcepto: [],
};

/**
 * Coproperty-wide summary powering the 3 Inicio KPI cards: Total Facturado
 * and Total Ingresos Recibidos (Total de Cartera is unchanged and sourced
 * from `CarteraGeneralService` instead, no work here). Both figures are
 * scoped to the coproperty's own "último periodo facturado" — the
 * `periodStart`/`periodEnd` of its most recently issued (non-anulada)
 * Factura, the same period pair every Factura already stores; no new
 * "current period" concept is introduced.
 */
@Injectable()
export class InicioResumenService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findResumen(): Promise<RespuestaInicioResumen> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // "Último periodo facturado": the periodStart/periodEnd of the most
    // recently ISSUED active Factura (max issueDate) — a brand-new
    // coproperty with no Factura yet has no period at all, a legitimate
    // empty state (spec's "Empty-state" note), never an error.
    const ultimaFactura = await this.facturas
      .findOne({ coPropertyId, status: 'emitida' })
      .sort({ issueDate: -1 })
      .exec();

    if (!ultimaFactura) {
      return RESUMEN_VACIO;
    }

    const { periodStart, periodEnd } = ultimaFactura;

    // Card 1: Total Facturado — every active Factura sharing that exact
    // period pair (a lote run issues many Facturas for the same period).
    const facturasDelPeriodo = await this.facturas
      .find({
        coPropertyId,
        status: 'emitida',
        periodStart,
        periodEnd,
      })
      .exec();

    let totalFacturado = 0;
    const facturadoMap = new Map<string, MontoPorConcepto>();
    for (const factura of facturasDelPeriodo) {
      totalFacturado += factura.total;
      for (const linea of factura.lines) {
        const key = linea.conceptoId.toString();
        const existente = facturadoMap.get(key);
        if (existente) {
          existente.monto += linea.totalAmount;
        } else {
          facturadoMap.set(key, {
            conceptoId: key,
            nombre: linea.conceptName,
            monto: linea.totalAmount,
          });
        }
      }
    }

    // Card 3: Total Ingresos Recibidos — gross cash, active Recibos whose
    // OWN receivedDate falls in the resolved period (same philosophy as
    // Estado de Cuenta's `pagosDelMes`, coproperty-wide instead of
    // per-inmueble).
    const recibosDelPeriodo = await this.recibos
      .find({
        coPropertyId,
        status: 'activo',
        receivedDate: { $gte: periodStart, $lte: periodEnd },
      })
      .exec();

    const totalIngresosRecibidos = recibosDelPeriodo.reduce(
      (sum, r) => sum + r.receivedAmount,
      0,
    );

    // Recibido por Concepto — built from active `sourceType: 'RC'`
    // applications whose source Recibo is one of the above (in-period,
    // active). `sourceType: 'NA'` (reapplying an OLD anticipo) is excluded
    // on purpose — that money isn't new cash received this period, same
    // reasoning Estado de Cuenta's "Anticipos Aplicados" split uses.
    const recibidoMap = new Map<string, MontoPorConcepto>();
    let totalConceptosEscalado = 0;

    if (recibosDelPeriodo.length > 0) {
      const reciboIds = recibosDelPeriodo.map((r) => r._id);
      const aplicacionesDelPeriodo = await this.aplicaciones
        .find({
          coPropertyId,
          sourceType: 'RC',
          status: 'activa',
          sourceId: { $in: reciboIds },
        })
        .exec();

      for (const app of aplicacionesDelPeriodo) {
        // `detalleConceptos[i].monto` records the FULL credit posted to a
        // concept, which can include an early-payment discount portion
        // (`discountApplied`) that isn't real received cash. Scaling every
        // line by (amountApplied - discountApplied) / amountApplied before
        // summing keeps the per-concept slices honest and leaves exactly
        // the real unapplied cash to fall through to the Anticipos slice
        // below — see the spec's worked example (Recibo $1.000.000 gross,
        // $909.800 cash + $52.200 discount applied → Anticipos must be
        // $90.200, not the naive $38.000).
        const factor =
          app.discountApplied > 0 && app.amountApplied > 0
            ? (app.amountApplied - app.discountApplied) / app.amountApplied
            : 1;

        for (const detalle of app.detalleConceptos) {
          const montoEscalado = detalle.monto * factor;
          const key = detalle.conceptoId.toString();
          const existente = recibidoMap.get(key);
          if (existente) {
            existente.monto += montoEscalado;
          } else {
            recibidoMap.set(key, {
              conceptoId: key,
              nombre: detalle.conceptName,
              monto: montoEscalado,
            });
          }
          totalConceptosEscalado += montoEscalado;
        }
      }
    }

    const recibidoPorConcepto = [...recibidoMap.values()];

    // Anticipos slice: whatever's left of the gross received total after
    // the scaled concept slices — by construction this always equals the
    // real unapplied cash for those Recibos (reconciles with
    // `SaldoDocumentoOrigen.saldoDisponible` the same way Estado de
    // Cuenta's Anticipos Pendientes already does), no separate query
    // needed. Only included when positive, same "only show a slice if the
    // value is positive" convention `vencimientos-cartera` already uses.
    const anticipos = totalIngresosRecibidos - totalConceptosEscalado;
    if (anticipos > 0) {
      recibidoPorConcepto.push({
        conceptoId: 'anticipos',
        nombre: 'Anticipos',
        monto: anticipos,
      });
    }

    return {
      periodo: {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      },
      totalFacturado,
      facturadoPorConcepto: [...facturadoMap.values()],
      totalIngresosRecibidos,
      recibidoPorConcepto,
    };
  }
}
