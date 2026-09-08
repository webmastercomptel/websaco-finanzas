import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  RespuestaConsultaFacturacion,
  TotalConceptoLote,
  FilaConsultaFacturacion,
} from '../../contracts';

/**
 * The results of one billing run ("Consulta de Facturación", §3.1 of the
 * predecessor system): per-concept totals plus a per-invoice detail table,
 * both derived live from the lote's real Facturas — never from the fixed
 * twelve-concept slots the predecessor hardcoded.
 *
 * A focused query against `Factura`, not a reuse of
 * `FacturasService.findAllRawPorLote` (that one exists for the bulk PDF,
 * which prints every Factura of a lote regardless of status). This report is
 * a financial aggregate: an `anulada` Factura must not inflate its totals.
 */
@Injectable()
export class ConsultaFacturacionService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async generar(loteId: string): Promise<RespuestaConsultaFacturacion> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const lote = await this.lotes.findOne({ _id: loteId, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }
    if (lote.status !== 'consolidado') {
      throw new ConflictException(
        `El lote ${loteId} aún no está consolidado; la consulta de facturación solo está disponible para lotes consolidados`,
      );
    }

    const facturas = await this.facturas
      .find({ coPropertyId, loteId, status: 'emitida' })
      .sort({ unitCode: 1 })
      .exec();

    // Distinct concepts actually present, resolved to their frozen line
    // conceptName (never the mutable ConceptoCobro.name) — order is
    // presentational, so it's fine to resolve it from the live catalog even
    // for a historical lote.
    const conceptoIds = new Set<string>();
    const nombrePorId = new Map<string, string>();
    for (const f of facturas) {
      for (const l of f.lines) {
        const key = l.conceptoId.toString();
        conceptoIds.add(key);
        if (!nombrePorId.has(key)) nombrePorId.set(key, l.conceptName);
      }
    }

    const catalogo = conceptoIds.size
      ? await this.conceptos
          .find({ coPropertyId, _id: { $in: [...conceptoIds] } })
          .exec()
      : [];
    const ordenPorId = new Map(
      catalogo.map((c) => [c._id.toString(), c.sortOrder]),
    );
    const idsOrdenados = [...conceptoIds].sort((a, b) => {
      const diff = (ordenPorId.get(a) ?? 0) - (ordenPorId.get(b) ?? 0);
      return diff !== 0
        ? diff
        : (nombrePorId.get(a) ?? '').localeCompare(nombrePorId.get(b) ?? '');
    });

    const totalPorConcepto = new Map<string, number>();
    const filas: FilaConsultaFacturacion[] = facturas.map((f) => {
      const valoresPorConcepto: Record<string, number> = {};
      for (const l of f.lines) {
        const key = l.conceptoId.toString();
        // A concept can appear on more than one line of the same invoice
        // (e.g. two novedades against the same concept) — sum, don't overwrite.
        valoresPorConcepto[key] = (valoresPorConcepto[key] ?? 0) + l.baseAmount;
        totalPorConcepto.set(
          key,
          (totalPorConcepto.get(key) ?? 0) + l.baseAmount,
        );
      }
      return {
        inmuebleId: f.inmuebleId.toString(),
        inmuebleCodigo: f.unitCode,
        tipoDocumento: 'FV' as const,
        prefijo: f.prefix,
        numero: f.number,
        numeroCompleto: f.fullNumber,
        fechaFactura: f.issueDate.toISOString(),
        fechaVence: f.dueDate.toISOString(),
        valoresPorConcepto,
        subtotal: f.subtotal,
        totalImpuestos: f.totalTax,
        total: f.total,
      };
    });

    const totalesPorConcepto: TotalConceptoLote[] = idsOrdenados.map((id) => ({
      conceptoId: id,
      nombreConcepto: nombrePorId.get(id) ?? '',
      monto: totalPorConcepto.get(id) ?? 0,
    }));
    const subtotal = facturas.reduce((acc, f) => acc + f.subtotal, 0);
    const totalImpuestos = facturas.reduce((acc, f) => acc + f.totalTax, 0);

    return {
      loteId: lote._id.toString(),
      loteNumero: lote.number,
      loteEstado: lote.status,
      fechaFacturacion: lote.billingDate.toISOString(),
      fechaVencimiento: lote.dueDate.toISOString(),
      totalesPorConcepto,
      subtotal,
      totalImpuestos,
      total: subtotal + totalImpuestos,
      filas,
    };
  }
}
