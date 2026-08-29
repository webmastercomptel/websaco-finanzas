import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { Factura as FacturaContract, Paginado } from '../../contracts';
import { toFactura } from './facturas.mapper';
import type { ListarFacturasDto } from './dto/listar-facturas.dto';

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
}
