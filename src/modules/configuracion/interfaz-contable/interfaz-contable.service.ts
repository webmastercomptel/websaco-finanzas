// src/modules/configuracion/interfaz-contable/interfaz-contable.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  InterfazContable,
  InterfazContableDocument,
} from '../../../database/schemas/contabilidad/interfaz-contable.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../../database/schemas/conceptos/concepto-cobro.schema';
import type { MapeoContable } from '../../../contracts';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { toMapeoContable } from './interfaz-contable.mapper';
import type { GuardarMapeoDto } from './dto/guardar-mapeo.dto';

@Injectable()
export class InterfazContableService {
  constructor(
    @InjectModel(InterfazContable.name)
    private readonly mapeos: Model<InterfazContableDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentas: Model<CuentaContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(): Promise<MapeoContable[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const docs = await this.mapeos
      .find({ coPropertyId })
      .populate('cuentaDebitoId', 'code')
      .populate('cuentaCreditoId', 'code')
      .populate('conceptoId', 'name')
      .exec();

    return docs.map((doc) => {
      const base = toMapeoContable(doc);
      const debitAccount =
        doc.cuentaDebitoId as unknown as CuentaContableDocument;
      const creditAccount =
        doc.cuentaCreditoId as unknown as CuentaContableDocument;
      const concepto = doc.conceptoId as unknown as ConceptoCobroDocument;
      return {
        ...base,
        cuentaDebitoCodigo: debitAccount?.code ?? null,
        cuentaCreditoCodigo: creditAccount?.code ?? null,
        conceptoNombre: concepto?.name ?? null,
      };
    });
  }

  async upsert(dto: GuardarMapeoDto): Promise<MapeoContable> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // Validate both accounts exist in the same coproperty.
    const [cuentaDb, cuentaCr] = await Promise.all([
      this.cuentas
        .findOne({
          _id: dto.cuentaDebitoId,
          coPropertyId,
        })
        .exec(),
      this.cuentas
        .findOne({
          _id: dto.cuentaCreditoId,
          coPropertyId,
        })
        .exec(),
    ]);

    if (!cuentaDb) {
      throw new BadRequestException(
        `La cuenta de débito ${dto.cuentaDebitoId} no existe en esta copropiedad.`,
      );
    }
    if (!cuentaCr) {
      throw new BadRequestException(
        `La cuenta de crédito ${dto.cuentaCreditoId} no existe en esta copropiedad.`,
      );
    }

    const filtro: Record<string, unknown> = { coPropertyId };

    if (dto.cargoTipo === 'concepto') {
      if (!dto.conceptoId) {
        throw new BadRequestException(
          'conceptoId es requerido para cargoTipo "concepto".',
        );
      }
      const concepto = await this.conceptos
        .findOne({
          _id: dto.conceptoId,
          coPropertyId,
        })
        .exec();
      if (!concepto) {
        throw new BadRequestException(
          `El concepto ${dto.conceptoId} no existe en esta copropiedad.`,
        );
      }
      filtro.conceptoId = new Types.ObjectId(dto.conceptoId);
    } else {
      if (!dto.cargoEspecial) {
        throw new BadRequestException(
          'cargoEspecial es requerido para cargoTipo "especial".',
        );
      }
      filtro.cargoEspecial = dto.cargoEspecial;
    }

    const update = {
      cargoTipo: dto.cargoTipo,
      conceptoId: dto.conceptoId ? new Types.ObjectId(dto.conceptoId) : null,
      cargoEspecial: dto.cargoEspecial ?? null,
      cuentaDebitoId: new Types.ObjectId(dto.cuentaDebitoId),
      cuentaCreditoId: new Types.ObjectId(dto.cuentaCreditoId),
    };

    const existing = await this.mapeos.findOne(filtro).exec();

    let doc: InterfazContableDocument;
    if (existing) {
      doc = (await this.mapeos
        .findByIdAndUpdate(existing._id, { $set: update }, { new: true })
        .exec())!;
    } else {
      doc = await this.mapeos.create({
        coPropertyId,
        ...update,
      });
    }

    return toMapeoContable(doc);
  }

  async remove(id: string): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const result = await this.mapeos
      .deleteOne({ _id: id, coPropertyId })
      .exec();

    if (result.deletedCount === 0) {
      throw new NotFoundException(`No se encontró el mapeo ${id}`);
    }
  }
}
