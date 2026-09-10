import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
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
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(query: ListarFacturasDto): Promise<Paginado<FacturaContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.buscar) {
      // Escaped: a search box is user input, and an unescaped regex lets a
      // stray "(" throw, or a crafted one pin the database at 100%.
      filtro.fullNumber = { $regex: escapeRegex(query.buscar), $options: 'i' };
    }
    if (query.conSaldoPendiente) {
      filtro.outstandingBalance = { $gt: 0 };
      filtro.status = 'emitida';
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

    return { items: documentos.map(toFactura), total, pagina, porPagina };
  }

  async findOne(id: string): Promise<FacturaContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.facturas
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la factura ${id}`);
    }
    return toFactura(documento);
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation which needs
   * fields like `resolucionId` that the mapped contract intentionally omits.
   */
  async findOneRaw(id: string): Promise<FacturaDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.facturas
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la factura ${id}`);
    }
    return documento;
  }

  /**
   * Every Factura one lote's consolidación produced, raw — used by the
   * "todas las facturas" bulk PDF (`LotesController`), same reason
   * `findOneRaw` skips the mapped contract: PDF generation needs
   * `resolucionId` and the other fields the Spanish contract omits.
   * Ordered by unit code, the same order the roster and the Liquidación
   * table already use, so a printed batch reads in a predictable sequence.
   */
  async findAllRawPorLote(loteId: string): Promise<FacturaDocument[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.facturas
      .find({ coPropertyId, loteId })
      .sort({ unitCode: 1 })
      .exec();
  }
}
