import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import {
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type { Factura as FacturaContract, Paginado } from '../../contracts';
import { toFactura } from './facturas.mapper';
import type { ListarFacturasDto } from './dto/listar-facturas.dto';

export type { FacturaDocument };

@Injectable()
export class FacturasService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /** Batch-resolves each document's own live per-concepto breakdown from
   *  `CarteraPorDocumento` — needed by `toFactura`'s per-línea
   *  `saldoPendiente`, no longer a field the document itself carries. */
  private async carteraPorConceptoDe(
    documentoIds: FacturaDocument['_id'][],
  ): Promise<Map<string, Map<string, number>>> {
    const filas = documentoIds.length
      ? await this.carteraPorDocumento
          .find({ documentoId: { $in: documentoIds } })
          .exec()
      : [];
    const porDocumento = new Map<string, Map<string, number>>();
    for (const fila of filas) {
      const docKey = fila.documentoId.toString();
      const porConcepto = porDocumento.get(docKey) ?? new Map<string, number>();
      porConcepto.set(fila.conceptoId.toString(), fila.saldoPendiente);
      porDocumento.set(docKey, porConcepto);
    }
    return porDocumento;
  }

  async findAll(query: ListarFacturasDto): Promise<Paginado<FacturaContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.buscar) {
      // Escaped: a search box is user input, and an unescaped regex lets a
      // stray "(" throw, or a crafted one pin the database at 100%.
      filtro.fullNumber = { $regex: escapeRegex(query.buscar), $options: 'i' };
    }
    if (query.estado) {
      filtro.status = query.estado;
    } else if (query.conSaldoPendiente) {
      filtro.status = 'emitida';
    }
    if (query.conSaldoPendiente) {
      // No longer a field on Factura itself — resolve candidate ids from
      // `SaldoTotalDocumento` first (see that schema's own docblock), same
      // pattern `NotasDebitoService.findAll` already uses.
      const conSaldo = await this.saldoTotalDocumento
        .find({ coPropertyId, tipoDocumento: 'FV', saldoPendiente: { $gt: 0 } })
        .exec();
      filtro._id = { $in: conSaldo.map((s) => s.documentoId) };
    }
    if (query.fechaDesde || query.fechaHasta) {
      filtro.issueDate = {
        ...(query.fechaDesde ? { $gte: new Date(query.fechaDesde) } : {}),
        ...(query.fechaHasta ? { $lte: new Date(query.fechaHasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.facturas
        .find(filtro)
        .sort({ issueDate: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.facturas.countDocuments(filtro).exec(),
    ]);

    const ids = documentos.map((d) => d._id);
    const [saldos, carteraPorDoc] = await Promise.all([
      ids.length
        ? this.saldoTotalDocumento.find({ documentoId: { $in: ids } }).exec()
        : Promise.resolve([]),
      this.carteraPorConceptoDe(ids),
    ]);
    const saldoPorDocumento = new Map(
      saldos.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );

    return {
      // `documentDefinition` nulled out here on purpose — a listing page
      // (default 50/página) has no use for each row's full frozen
      // presentation tree, and shipping it here would multiply the payload
      // for no reason. `findOne` below is the only place that needs it.
      items: documentos.map((doc) => ({
        ...toFactura(
          doc,
          saldoPorDocumento.get(doc._id.toString()) ?? 0,
          carteraPorDoc.get(doc._id.toString()) ?? new Map<string, number>(),
        ),
        documentDefinition: null,
      })),
      total,
      pagina,
      porPagina,
    };
  }

  async findOne(id: string): Promise<FacturaContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.facturas
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la factura ${id}`);
    }
    const [saldoTotal, carteraPorDoc] = await Promise.all([
      this.saldoTotalDocumento.findOne({ documentoId: documento._id }).exec(),
      this.carteraPorConceptoDe([documento._id]),
    ]);
    return toFactura(
      documento,
      saldoTotal?.saldoPendiente ?? 0,
      carteraPorDoc.get(documento._id.toString()) ?? new Map<string, number>(),
    );
  }

  /**
   * Every Factura one lote's consolidación produced, raw — used by
   * `LotesController.obtenerDocumentosFacturas` to hand the browser each
   * invoice's own frozen `documentDefinition` (the mapped contract skips
   * that field's raw shape; this reads it as `.lean()` gave it to us).
   * Ordered by unit code, the same order the roster and the Liquidación
   * table already use, so a batch reads in a predictable sequence.
   *
   * `.lean()` on purpose: a lote can carry hundreds of Facturas, and this
   * only ever needs plain fields (see `FacturaLean` below, also used by
   * `paginaFactura` when `consolidar()` first builds each `documentDefinition`)
   * — hydrating full Mongoose documents here is pure overhead this batch
   * endpoint can't afford under Cloud Run's memory ceiling.
   */
  async findAllRawPorLote(loteId: string) {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.facturas
      .find({ coPropertyId, loteId })
      .sort({ unitCode: 1 })
      .lean()
      .exec();
  }
}

/**
 * Plain-object shape `.lean()` resolves for a Factura — every field a
 * consumer of `findAllRawPorLote` can rely on, without the full Mongoose
 * document's methods/getters. Derived from the method's own inferred return
 * type rather than a hand-rolled `LeanDocument<...>` (removed in Mongoose
 * 6+) — see `findAllRawPorLote` above.
 */
export type FacturaLean = Awaited<
  ReturnType<FacturasService['findAllRawPorLote']>
>[number];
