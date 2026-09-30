// src/modules/configuracion/parametros/parametros.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import type { ActualizarParametrosDto } from './dto/actualizar-parametros.dto';

/** The billing parameters the frontend reads/writes. */
export interface ParametrosFacturacion {
  descuentoHabilitado: boolean;
  porcentajeDescuento: number;
  valorFijoDescuento: number;
  diasGraciaDescuento: number;
  descuentoAplicaConMora: boolean;
  moraHabilitada: boolean;
  tasaInteresMora: number;
  topeValorMora: number | null;
  cuentaBancoPredeterminada: string | null;
  observacionesFacturacion: string | null;
  centroCostos: string | null;
  otrosIngresosDebito: string | null;
  otrosIngresosCredito: string | null;
  descuentosDebito: string | null;
  descuentosCredito: string | null;
  cuentasOrdenDebito: string | null;
  cuentasOrdenCredito: string | null;
  usaCuentasOrden: boolean;
  cuentaAnticipos: string | null;
  codigoFlujoCaja: string | null;
}

@Injectable()
export class ParametrosService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findOne(): Promise<ParametrosFacturacion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const doc = await this.copropiedades.findById(copropiedadId).exec();
    if (!doc) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }
    return {
      descuentoHabilitado: doc.descuentoHabilitado,
      porcentajeDescuento: doc.descuentoPorcentaje,
      valorFijoDescuento: doc.descuentoValorFijo,
      diasGraciaDescuento: doc.descuentoDiasGracia,
      descuentoAplicaConMora: doc.descuentoAplicaConMora,
      moraHabilitada: doc.moraHabilitada,
      tasaInteresMora: doc.moraTasaInteres,
      topeValorMora: doc.moraValorLimite,
      cuentaBancoPredeterminada: doc.cuentaBancariaDefecto,
      observacionesFacturacion: doc.notasFacturacion,
      centroCostos: doc.centroCostoDefecto,
      otrosIngresosDebito: doc.otrosIngresosCuentaDebito,
      otrosIngresosCredito: doc.otrosIngresosCuentaCredito,
      descuentosDebito: doc.descuentosCuentaDebito,
      descuentosCredito: doc.descuentosCuentaCredito,
      cuentasOrdenDebito: doc.cuentaOrdenDebito,
      cuentasOrdenCredito: doc.cuentaOrdenCredito,
      usaCuentasOrden: doc.usaCuentasOrden,
      cuentaAnticipos: doc.cuentaAnticipos,
      codigoFlujoCaja: doc.flujoCajaCodigo,
    };
  }

  async update(dto: ActualizarParametrosDto): Promise<ParametrosFacturacion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const update: Record<string, unknown> = {};
    const set = (k: string, v: unknown): void => {
      if (v !== undefined) update[k] = v;
    };

    set('descuentoHabilitado', dto.descuentoHabilitado);
    set('descuentoPorcentaje', dto.porcentajeDescuento);
    set('descuentoValorFijo', dto.valorFijoDescuento);
    set('descuentoDiasGracia', dto.diasGraciaDescuento);
    set('descuentoAplicaConMora', dto.descuentoAplicaConMora);
    set('moraHabilitada', dto.moraHabilitada);
    set('moraTasaInteres', dto.tasaInteresMora);
    set('moraValorLimite', dto.topeValorMora);
    set('cuentaBancariaDefecto', dto.cuentaBancoPredeterminada);
    set('notasFacturacion', dto.observacionesFacturacion);
    set('centroCostoDefecto', dto.centroCostos);
    set('otrosIngresosCuentaDebito', dto.otrosIngresosDebito);
    set('otrosIngresosCuentaCredito', dto.otrosIngresosCredito);
    set('descuentosCuentaDebito', dto.descuentosDebito);
    set('descuentosCuentaCredito', dto.descuentosCredito);
    set('cuentaOrdenDebito', dto.cuentasOrdenDebito);
    set('cuentaOrdenCredito', dto.cuentasOrdenCredito);
    set('usaCuentasOrden', dto.usaCuentasOrden);
    set('cuentaAnticipos', dto.cuentaAnticipos);
    set('flujoCajaCodigo', dto.codigoFlujoCaja);

    const updated = await this.copropiedades
      .findByIdAndUpdate(
        copropiedadId,
        { $set: update },
        { returnDocument: 'after' },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }

    return {
      descuentoHabilitado: updated.descuentoHabilitado,
      porcentajeDescuento: updated.descuentoPorcentaje,
      valorFijoDescuento: updated.descuentoValorFijo,
      diasGraciaDescuento: updated.descuentoDiasGracia,
      descuentoAplicaConMora: updated.descuentoAplicaConMora,
      moraHabilitada: updated.moraHabilitada,
      tasaInteresMora: updated.moraTasaInteres,
      topeValorMora: updated.moraValorLimite,
      cuentaBancoPredeterminada: updated.cuentaBancariaDefecto,
      observacionesFacturacion: updated.notasFacturacion,
      centroCostos: updated.centroCostoDefecto,
      otrosIngresosDebito: updated.otrosIngresosCuentaDebito,
      otrosIngresosCredito: updated.otrosIngresosCuentaCredito,
      descuentosDebito: updated.descuentosCuentaDebito,
      descuentosCredito: updated.descuentosCuentaCredito,
      cuentasOrdenDebito: updated.cuentaOrdenDebito,
      cuentasOrdenCredito: updated.cuentaOrdenCredito,
      usaCuentasOrden: updated.usaCuentasOrden,
      cuentaAnticipos: updated.cuentaAnticipos,
      codigoFlujoCaja: updated.flujoCajaCodigo,
    };
  }
}
