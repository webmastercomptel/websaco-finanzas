// src/modules/inmuebles/progreso-importacion.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ProgresoImportacion,
  ProgresoImportacionDocument,
  type TipoImportacion,
} from '../../database/schemas/importaciones/progreso-importacion.schema';

/** What the frontend polls for while a bulk import request is in flight. */
export interface ProgresoActual {
  actual: number;
  total: number;
}

/**
 * Writes and reads the coarse, throttled progress row a bulk import updates
 * while it runs — see the schema's own note for why this exists and why it
 * is throttled rather than written per row. One instance is shared by every
 * import that wants this (today: `InmueblesService.importar`,
 * `ValoresRecurrentesService.importarMasivo`), keyed by `kind` so two
 * different imports for the same coproperty never clobber each other.
 */
@Injectable()
export class ProgresoImportacionService {
  constructor(
    @InjectModel(ProgresoImportacion.name)
    private readonly progresos: Model<ProgresoImportacionDocument>,
  ) {}

  /**
   * Computes a throttle interval capped at ~20 writes total regardless of
   * how many rows there are — same reasoning and same cap as
   * `LotesFacturacionService.consolidar`'s own `intervaloProgreso`: this
   * must never reintroduce a per-row round-trip cost.
   */
  intervalo(total: number): number {
    return Math.max(1, Math.ceil(total / 20));
  }

  /** Call once before the import loop starts. A `total` of 0 skips writing
   *  anything — nothing to poll for a file with no rows. */
  async iniciar(
    coPropertyId: Types.ObjectId,
    kind: TipoImportacion,
    total: number,
  ): Promise<void> {
    if (total === 0) return;
    await this.progresos
      .updateOne(
        { coPropertyId, kind },
        { $set: { current: 0, total } },
        { upsert: true },
      )
      .exec();
  }

  /** Call as the loop advances — the caller is responsible for only calling
   *  this every `intervalo(total)` rows (or on the last row), not every
   *  row. */
  async actualizar(
    coPropertyId: Types.ObjectId,
    kind: TipoImportacion,
    current: number,
    total: number,
  ): Promise<void> {
    await this.progresos
      .updateOne(
        { coPropertyId, kind },
        { $set: { current, total } },
        { upsert: true },
      )
      .exec();
  }

  /** Call once the import is over, success or failure — its absence IS
   *  "nothing in progress" (see `obtener`), never a row left at 100%. */
  async finalizar(
    coPropertyId: Types.ObjectId,
    kind: TipoImportacion,
  ): Promise<void> {
    await this.progresos.deleteOne({ coPropertyId, kind }).exec();
  }

  /** Null means no import of this kind is currently running for this
   *  coproperty — the frontend's cue to stop polling. */
  async obtener(
    coPropertyId: Types.ObjectId,
    kind: TipoImportacion,
  ): Promise<ProgresoActual | null> {
    const doc = await this.progresos.findOne({ coPropertyId, kind }).exec();
    return doc ? { actual: doc.current, total: doc.total } : null;
  }
}
