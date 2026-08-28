// src/common/contabilidad/periodo.service.ts
import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PeriodoContable,
  PeriodoContableDocument,
} from '../../database/schemas/contabilidad/periodo-contable.schema';

/** The month a date falls in, as the accounting calendar counts it. */
export interface Periodo {
  year: number;
  month: number;
}

/**
 * Reads a date as year and month in LOCAL time, not UTC.
 *
 * An invoice dated the 1st at 00:30 in Bogotá is January there and December in
 * UTC — the month boundary is exactly where an off-by-one lands a document in a
 * period somebody already closed.
 */
export const periodoDe = (fecha: Date): Periodo => ({
  year: fecha.getFullYear(),
  month: fecha.getMonth() + 1,
});

@Injectable()
export class PeriodoService {
  constructor(
    @InjectModel(PeriodoContable.name)
    private readonly periodos: Model<PeriodoContableDocument>,
  ) {}

  /** Whether a document dated `fecha` may still be posted. */
  async estaAbierto(coPropertyId: string, fecha: Date): Promise<boolean> {
    const { year, month } = periodoDe(fecha);

    const periodo = await this.periodos
      .findOne({
        coPropertyId: new Types.ObjectId(coPropertyId),
        year,
        month,
      })
      .lean()
      .exec();

    // No row means open. Periods are created when they are closed, so a
    // building nobody has closed a month for can still be billed — otherwise
    // somebody would have to manufacture twelve rows a year before anything
    // worked.
    return !periodo || periodo.status === 'abierto';
  }

  /**
   * Refuses the write when the month is closed.
   *
   * Every document that carries a date must pass through here before being
   * saved. Reaching back into a closed month contradicts statements already
   * handed to the council and moves the opening balances of every month after
   * it — a correction that looks tidy and quietly invalidates a year of
   * reports.
   *
   * The error says what to do instead, because the alternative is not "give
   * up": a mistake found today on a document from a closed month is corrected
   * with a credit note dated TODAY that references the old document. You post
   * into the open period and point backwards.
   */
  async exigirAbierto(coPropertyId: string, fecha: Date): Promise<void> {
    if (await this.estaAbierto(coPropertyId, fecha)) return;

    const { year, month } = periodoDe(fecha);
    throw new ConflictException(
      `El periodo ${String(month).padStart(2, '0')}/${year} está cerrado. ` +
        'Emitá el documento con fecha de hoy, referenciando el documento original.',
    );
  }
}
