import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { calcularDocumentosConSaldoAFecha } from './cartera-historica.util';
import type {
  RespuestaCarteraGeneral,
  CarteraPorConcepto,
  RecaudoMensual,
} from '../../contracts';
import type { ConsultarCarteraGeneralDto } from './dto/consultar-cartera-general.dto';

/** Compute days overdue: max(0, floor((corte - referenceDate) / day)). */
const calcularDiasMora = (fechaReferencia: Date, corte: Date): number => {
  const c = new Date(corte);
  c.setHours(0, 0, 0, 0);
  const ref = new Date(fechaReferencia);
  ref.setHours(0, 0, 0, 0);
  const diff = c.getTime() - ref.getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
};

/**
 * Coproperty-wide control dashboard: aggregate KPIs, per-concept breakdown,
 * and monthly collections trend. Sibling to Auxiliar de Cartera and
 * Vencimientos de Cartera (both per-inmueble; this one is coproperty-level).
 */
@Injectable()
export class CarteraGeneralService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldosCartera: Model<SaldoCarteraDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptosCobro: Model<ConceptoCobroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ConsultarCarteraGeneralDto,
  ): Promise<RespuestaCarteraGeneral> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const fecha = query.fecha ? new Date(query.fecha) : new Date();

    // §2: point-in-time documents for aggregate KPIs
    const documentos = await calcularDocumentosConSaldoAFecha(
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        aplicaciones: this.aplicaciones,
      },
      coPropertyId,
      fecha,
    );

    // Compute aggregate KPIs from documentos
    let totalCartera = 0;
    let totalVencido = 0;
    let totalPendiente = 0;

    for (const doc of documentos) {
      totalCartera += doc.montoPendiente;
      if (doc.fechaReferencia < fecha) {
        totalVencido += doc.montoPendiente;
      } else {
        totalPendiente += doc.montoPendiente;
      }
    }

    const porcentajeVencido =
      totalCartera > 0 ? (totalVencido / totalCartera) * 100 : 0;

    // diasPromedioMora: average across inmuebles currently vencido at fecha
    const diasMoraMap = new Map<string, number>();
    for (const doc of documentos) {
      if (doc.fechaReferencia < fecha) {
        const key = doc.inmuebleId.toString();
        const dm = calcularDiasMora(doc.fechaReferencia, fecha);
        diasMoraMap.set(key, Math.max(diasMoraMap.get(key) ?? 0, dm));
      }
    }
    const vencidoEntries = [...diasMoraMap.values()];
    const diasPromedioMora =
      vencidoEntries.length > 0
        ? vencidoEntries.reduce((a, b) => a + b, 0) / vencidoEntries.length
        : 0;

    // totalCarteraMesAnterior: same computation at last day of previous month
    const totalCarteraMesAnterior = await this.calcularTotalCarteraMesAnterior(
      coPropertyId,
      fecha,
    );

    // §4: cartera por concepto (always "as of now")
    const carteraPorConcepto = await this.calcularCarteraPorConcepto(coPropertyId);

    // §4: tendencia recaudo (last 6 calendar months)
    const tendenciaRecaudo = await this.calcularTendenciaRecaudo(coPropertyId, fecha);

    return {
      totalCartera,
      totalVencido,
      totalPendiente,
      porcentajeVencido,
      totalCarteraMesAnterior,
      diasPromedioMora: Math.round(diasPromedioMora * 10) / 10,
      carteraPorConcepto,
      tendenciaRecaudo,
    };
  }

  /** Compute totalCartera at the last day of the month before `fecha`. */
  private async calcularTotalCarteraMesAnterior(
    coPropertyId: Types.ObjectId,
    fecha: Date,
  ): Promise<number> {
    // Last day of previous month
    const prevMonth = new Date(fecha);
    prevMonth.setDate(0); // last day of previous month
    prevMonth.setHours(23, 59, 59, 999);

    const documentos = await calcularDocumentosConSaldoAFecha(
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        aplicaciones: this.aplicaciones,
      },
      coPropertyId,
      prevMonth,
    );

    return documentos.reduce((sum, doc) => sum + doc.montoPendiente, 0);
  }

  /**
   * Sum SaldoCartera.balance grouped by conceptoId, across every inmueble.
   * Always "as of now" — no historical dimension.
   */
  private async calcularCarteraPorConcepto(
    coPropertyId: Types.ObjectId,
  ): Promise<CarteraPorConcepto[]> {
    const saldos = await this.saldosCartera
      .find({ coPropertyId, balance: { $gt: 0 } })
      .exec();

    if (saldos.length === 0) return [];

    // Group by conceptoId and sum balances
    const conceptoMap = new Map<string, number>();
    for (const sc of saldos) {
      const key = sc.conceptoId.toString();
      conceptoMap.set(key, (conceptoMap.get(key) ?? 0) + sc.balance);
    }

    // Resolve concepto names
    const conceptoIds = [...conceptoMap.keys()].map(
      (id) => new Types.ObjectId(id),
    );
    const conceptos = await this.conceptosCobro
      .find({ coPropertyId, _id: { $in: conceptoIds } })
      .exec();

    const nombreMap = new Map<string, string>();
    for (const c of conceptos) {
      nombreMap.set(c._id.toString(), c.name);
    }

    return [...conceptoMap.entries()].map(([conceptoId, saldo]) => ({
      conceptoId,
      nombre: nombreMap.get(conceptoId) ?? 'Desconocido',
      saldo,
    }));
  }

  /**
   * Sum active AplicacionCartera.amountApplied by month for the last
   * 6 calendar months up to and including `fecha`'s month.
   *
   * A reverted application contributes to NO month's recaudo — only
   * currently active applications count.
   */
  private async calcularTendenciaRecaudo(
    coPropertyId: Types.ObjectId,
    fecha: Date,
  ): Promise<RecaudoMensual[]> {
    // Start of the window: first day of 6 months ago
    const startMonth = new Date(fecha);
    startMonth.setMonth(startMonth.getMonth() - 5, 1);
    startMonth.setHours(0, 0, 0, 0);

    const apps = await this.aplicaciones
      .find({
        coPropertyId,
        status: 'activa',
        appliedAt: { $gte: startMonth, $lte: fecha },
      })
      .exec();

    // Build the 6-month skeleton
    const buckets = new Map<string, number>();
    const monthKeys: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(fecha);
      d.setMonth(d.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets.set(key, 0);
      monthKeys.push(key);
    }

    // Fill buckets
    for (const app of apps) {
      const d = app.appliedAt;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (buckets.has(key)) {
        buckets.set(key, (buckets.get(key) ?? 0) + app.amountApplied);
      }
    }

    return monthKeys.map((key) => {
      const [anioStr, mesStr] = key.split('-');
      return {
        anio: Number(anioStr),
        mes: Number(mesStr),
        monto: buckets.get(key) ?? 0,
      };
    });
  }
}
