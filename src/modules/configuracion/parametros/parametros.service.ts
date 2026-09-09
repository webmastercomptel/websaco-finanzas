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
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const doc = await this.copropiedades.findById(coPropertyId).exec();
    if (!doc) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }
    return {
      descuentoHabilitado: doc.discountEnabled,
      porcentajeDescuento: doc.discountPercentage,
      valorFijoDescuento: doc.discountFixedValue,
      diasGraciaDescuento: doc.discountGraceDays,
      descuentoAplicaConMora: doc.discountAppliesWithLateFee,
      moraHabilitada: doc.lateFeeEnabled,
      tasaInteresMora: doc.lateFeeInterestRate,
      topeValorMora: doc.lateFeeValueLimit,
      cuentaBancoPredeterminada: doc.defaultBankAccountCode,
      observacionesFacturacion: doc.billingNotes,
      centroCostos: doc.defaultCostCentre,
      otrosIngresosDebito: doc.otherIncomeDebitAccount,
      otrosIngresosCredito: doc.otherIncomeCreditAccount,
      descuentosDebito: doc.discountsDebitAccount,
      descuentosCredito: doc.discountsCreditAccount,
      cuentasOrdenDebito: doc.memorandumDebitAccount,
      cuentasOrdenCredito: doc.memorandumCreditAccount,
      usaCuentasOrden: doc.usesMemorandumAccounts,
      cuentaAnticipos: doc.advancesAccount,
      codigoFlujoCaja: doc.cashFlowCode,
    };
  }

  async update(dto: ActualizarParametrosDto): Promise<ParametrosFacturacion> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const update: Record<string, unknown> = {};
    const set = (k: string, v: unknown): void => {
      if (v !== undefined) update[k] = v;
    };

    set('discountEnabled', dto.descuentoHabilitado);
    set('discountPercentage', dto.porcentajeDescuento);
    set('discountFixedValue', dto.valorFijoDescuento);
    set('discountGraceDays', dto.diasGraciaDescuento);
    set('discountAppliesWithLateFee', dto.descuentoAplicaConMora);
    set('lateFeeEnabled', dto.moraHabilitada);
    set('lateFeeInterestRate', dto.tasaInteresMora);
    set('lateFeeValueLimit', dto.topeValorMora);
    set('defaultBankAccountCode', dto.cuentaBancoPredeterminada);
    set('billingNotes', dto.observacionesFacturacion);
    set('defaultCostCentre', dto.centroCostos);
    set('otherIncomeDebitAccount', dto.otrosIngresosDebito);
    set('otherIncomeCreditAccount', dto.otrosIngresosCredito);
    set('discountsDebitAccount', dto.descuentosDebito);
    set('discountsCreditAccount', dto.descuentosCredito);
    set('memorandumDebitAccount', dto.cuentasOrdenDebito);
    set('memorandumCreditAccount', dto.cuentasOrdenCredito);
    set('usesMemorandumAccounts', dto.usaCuentasOrden);
    set('advancesAccount', dto.cuentaAnticipos);
    set('cashFlowCode', dto.codigoFlujoCaja);

    const updated = await this.copropiedades
      .findByIdAndUpdate(
        coPropertyId,
        { $set: update },
        { returnDocument: 'after' },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return {
      descuentoHabilitado: updated.discountEnabled,
      porcentajeDescuento: updated.discountPercentage,
      valorFijoDescuento: updated.discountFixedValue,
      diasGraciaDescuento: updated.discountGraceDays,
      descuentoAplicaConMora: updated.discountAppliesWithLateFee,
      moraHabilitada: updated.lateFeeEnabled,
      tasaInteresMora: updated.lateFeeInterestRate,
      topeValorMora: updated.lateFeeValueLimit,
      cuentaBancoPredeterminada: updated.defaultBankAccountCode,
      observacionesFacturacion: updated.billingNotes,
      centroCostos: updated.defaultCostCentre,
      otrosIngresosDebito: updated.otherIncomeDebitAccount,
      otrosIngresosCredito: updated.otherIncomeCreditAccount,
      descuentosDebito: updated.discountsDebitAccount,
      descuentosCredito: updated.discountsCreditAccount,
      cuentasOrdenDebito: updated.memorandumDebitAccount,
      cuentasOrdenCredito: updated.memorandumCreditAccount,
      usaCuentasOrden: updated.usesMemorandumAccounts,
      cuentaAnticipos: updated.advancesAccount,
      codigoFlujoCaja: updated.cashFlowCode,
    };
  }
}
