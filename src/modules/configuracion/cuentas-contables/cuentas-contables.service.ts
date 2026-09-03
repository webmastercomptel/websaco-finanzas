// src/modules/configuracion/cuentas-contables/cuentas-contables.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../../database/schemas/contabilidad/cuenta-contable.schema';
import type { CuentaContableContract, Paginado } from '../../../contracts';
import { toCuentaContable } from './cuentas-contables.mapper';
import type { ListarCuentasDto } from './dto/listar-cuentas.dto';
import type {
  ActualizarCuentaDto,
  CrearCuentaDto,
} from './dto/guardar-cuenta.dto';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../../common/utils/query.utils';

@Injectable()
export class CuentasContablesService {
  constructor(
    @InjectModel(CuentaContable.name)
    private readonly cuentas: Model<CuentaContableDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ListarCuentasDto,
  ): Promise<Paginado<CuentaContableContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };

    if (query.estado !== 'todos') {
      filtro.active = query.estado !== 'inactivo';
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      filtro.$or = [{ code: patron }, { name: patron }];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.cuentas
        .find(filtro)
        .sort({ code: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.cuentas.countDocuments(filtro).exec(),
    ]);

    return {
      items: documentos.map(toCuentaContable),
      total,
      pagina,
      porPagina,
    };
  }

  async findOne(id: string): Promise<CuentaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const doc = await this.cuentas.findOne({ _id: id, coPropertyId }).exec();
    if (!doc) {
      throw new NotFoundException(`No se encontró la cuenta ${id}`);
    }
    return toCuentaContable(doc);
  }

  async create(dto: CrearCuentaDto): Promise<CuentaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const yaExiste = await this.cuentas
      .exists({ coPropertyId, code: dto.codigo })
      .exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una cuenta con el código ${dto.codigo}`,
      );
    }

    const creada = await this.cuentas.create({
      coPropertyId,
      code: dto.codigo,
      name: dto.nombre,
      requiresTercero: dto.requiereTercero ?? false,
      cashFlow: dto.flujoCaja ?? false,
      profitCenterCode: dto.centroUtilidad ?? null,
      destinationCenterCode: dto.centroDestino ?? null,
      requiresCrossDocument: dto.requiereDocumentoCruce ?? false,
      taxType: dto.tipoImpuesto ?? null,
      taxRate: dto.tasaImpuesto ?? 0,
    });

    return toCuentaContable(creada);
  }

  async update(
    id: string,
    dto: ActualizarCuentaDto,
  ): Promise<CuentaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (dto.codigo) {
      const choca = await this.cuentas
        .exists({ coPropertyId, code: dto.codigo, _id: { $ne: id } })
        .exec();
      if (choca) {
        throw new ConflictException(
          `Ya existe otra cuenta con el código ${dto.codigo}`,
        );
      }
    }

    const update: Record<string, unknown> = {};
    const set = (k: string, v: unknown): void => {
      if (v !== undefined) update[k] = v;
    };

    set('code', dto.codigo);
    set('name', dto.nombre);
    set('requiresTercero', dto.requiereTercero);
    set('cashFlow', dto.flujoCaja);
    set('profitCenterCode', dto.centroUtilidad);
    set('destinationCenterCode', dto.centroDestino);
    set('requiresCrossDocument', dto.requiereDocumentoCruce);
    set('taxType', dto.tipoImpuesto);
    set('taxRate', dto.tasaImpuesto);
    if (dto.activo !== undefined) {
      update.active = dto.activo;
    }

    const actualizada = await this.cuentas
      .findOneAndUpdate(
        { _id: id, coPropertyId },
        { $set: update },
        { new: true },
      )
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la cuenta ${id}`);
    }
    return toCuentaContable(actualizada);
  }
}
