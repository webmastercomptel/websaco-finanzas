// src/modules/inmuebles/valores-recurrentes.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../../database/schemas/conceptos/valor-recurrente.schema';
import type {
  ResultadoImportacionValoresRecurrentes,
  ValorRecurrente as ValorRecurrenteContract,
  ValorRecurrenteMasivo,
} from '../../contracts';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { toValorRecurrente } from './valores-recurrentes.mapper';
import type { GuardarValoresRecurrentesDto } from './dto/guardar-valores-recurrentes.dto';
import type { ImportarValoresRecurrentesMasivoDto } from './dto/importar-valores-recurrentes.dto';
import {
  ProgresoImportacionService,
  type ProgresoActual,
} from './progreso-importacion.service';

/**
 * Manages one unit's recurring monthly amounts — the "Datos Financieros" tab
 * of the system this replaces, rebuilt as rows over the coproperty's actual
 * concept catalog instead of twelve fixed columns. See the note on the
 * `ValorRecurrente` contract type and schema for the full design.
 */
@Injectable()
export class ValoresRecurrentesService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
    private readonly tenant: TenantContextService,
    private readonly progreso: ProgresoImportacionService,
  ) {}

  private async exigirInmueble(inmuebleId: string): Promise<{
    coPropertyId: Types.ObjectId;
    inmuebleOid: Types.ObjectId;
  }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleOid = new Types.ObjectId(inmuebleId);
    const existe = await this.inmuebles
      .exists({ _id: inmuebleOid, coPropertyId })
      .exec();
    if (!existe) {
      throw new NotFoundException(`No se encontró el inmueble ${inmuebleId}`);
    }
    return { coPropertyId, inmuebleOid };
  }

  /**
   * One entry per concept in the building's catalog, `intereses` INCLUDED —
   * shown for context (the screen lists every cargo the building has), but
   * `guardar` below refuses to persist a value against it: that line is
   * computed from overdue balances, never a flat amount (see the note on
   * `ConceptoCobro.kind`), and saving one would double-charge it alongside
   * `LotesFacturacionService`'s own mora calculation. A concept without a
   * `ValorRecurrente` row for this unit shows `monto: 0`, indistinguishable
   * from a saved zero — see the contract type's own note on why saving 0
   * deletes the row instead of persisting it.
   */
  async obtener(inmuebleId: string): Promise<ValorRecurrenteContract[]> {
    const { coPropertyId, inmuebleOid } = await this.exigirInmueble(inmuebleId);

    const [conceptos, valores] = await Promise.all([
      this.conceptos.find({ coPropertyId }).sort({ sortOrder: 1 }).exec(),
      this.valoresRecurrentes
        .find({ coPropertyId, inmuebleId: inmuebleOid })
        .exec(),
    ]);

    const montoPorConcepto = new Map(
      valores.map((v) => [v.conceptoId.toString(), v.amount]),
    );

    return conceptos.map((concepto) =>
      toValorRecurrente(
        concepto,
        montoPorConcepto.get(concepto._id.toString()) ?? 0,
      ),
    );
  }

  /**
   * Replaces the unit's whole set of recurring amounts to match `dto.valores`
   * exactly: a positive amount upserts that pair's row, `0` deletes it. Plain
   * per-pair writes, not one Mongo transaction — each pair is independent
   * data, not a multi-collection accounting effect the way posting a
   * document is.
   */
  async guardar(
    inmuebleId: string,
    dto: GuardarValoresRecurrentesDto,
  ): Promise<ValorRecurrenteContract[]> {
    const { coPropertyId, inmuebleOid } = await this.exigirInmueble(inmuebleId);

    // Refuses a flat amount against the `intereses` concepto — see the note
    // on `obtener` above. Checked against the DB, not trusted from a
    // `tipoConcepto` the client might send back, since this DTO carries no
    // such field at all.
    const interesConcepto = await this.conceptos
      .findOne({ coPropertyId, kind: 'intereses' })
      .exec();
    if (interesConcepto) {
      const lineaIntereses = dto.valores.find(
        (v) => v.conceptoId === interesConcepto._id.toString(),
      );
      if (lineaIntereses && lineaIntereses.monto > 0) {
        throw new ConflictException(
          `El concepto "${interesConcepto.name}" se calcula automáticamente sobre la cartera vencida y no admite un valor recurrente fijo`,
        );
      }
    }

    await Promise.all(
      dto.valores.map(async (linea) => {
        const conceptoOid = new Types.ObjectId(linea.conceptoId);
        if (linea.monto > 0) {
          await this.valoresRecurrentes
            .findOneAndUpdate(
              {
                coPropertyId,
                inmuebleId: inmuebleOid,
                conceptoId: conceptoOid,
              },
              { $set: { amount: linea.monto } },
              { upsert: true },
            )
            .exec();
        } else {
          await this.valoresRecurrentes
            .deleteOne({
              coPropertyId,
              inmuebleId: inmuebleOid,
              conceptoId: conceptoOid,
            })
            .exec();
        }
      }),
    );

    return this.obtener(inmuebleId);
  }

  /**
   * Every active unit's recurring amounts in one shot — what the
   * coproperty-wide "Valores Recurrentes" export builds its editable
   * template from, instead of one request per unit. `intereses` excluded,
   * same reasoning as `obtener`: it is never a flat amount to export/import.
   */
  async obtenerTodos(): Promise<ValorRecurrenteMasivo[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const [unidades, valores] = await Promise.all([
      this.inmuebles
        .find({ coPropertyId, status: 'active' })
        .sort({ code: 1 })
        .exec(),
      this.valoresRecurrentes.find({ coPropertyId }).exec(),
    ]);

    const valoresPorInmueble = new Map<string, Map<string, number>>();
    for (const v of valores) {
      const inmuebleKey = v.inmuebleId.toString();
      const porConcepto =
        valoresPorInmueble.get(inmuebleKey) ?? new Map<string, number>();
      porConcepto.set(v.conceptoId.toString(), v.amount);
      valoresPorInmueble.set(inmuebleKey, porConcepto);
    }

    return unidades.map((u) => ({
      inmuebleId: u._id.toString(),
      codigo: u.code,
      valores: [
        ...(valoresPorInmueble.get(u._id.toString()) ??
          new Map<string, number>()),
      ].map(([conceptoId, monto]) => ({ conceptoId, monto })),
    }));
  }

  /**
   * Bulk-loads recurring amounts across many units by their `codigo`, from a
   * file exported/edited elsewhere and parsed into rows on the frontend (see
   * the note on `ImportarValoresRecurrentesMasivoDto`). Reuses `guardar` per
   * matched row — same validation (the `intereses` guard, upsert-or-delete on
   * zero) a manual edit of one unit's tab would get — so a bad row (an
   * unknown code, or a flat amount against `intereses`) fails only that row.
   *
   * Deliberately never creates, deletes or otherwise edits an `Inmueble` —
   * only the ones a code actually matches get their `ValorRecurrente` rows
   * touched, unlike `InmueblesService.importar`'s full-roster replace. Since
   * nothing here is destructive, `codigoCopropiedad` is checked per row
   * (like every other row-level rule below) rather than aborting the whole
   * file the way `InmueblesService.importar` does — see
   * `FilaValorRecurrenteMasivoDto.codigoCopropiedad`'s own note.
   */
  async importarMasivo(
    dto: ImportarValoresRecurrentesMasivoDto,
  ): Promise<ResultadoImportacionValoresRecurrentes> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap (see
    // backend/CLAUDE.md's own note on this exact mistake).
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const errores: ResultadoImportacionValoresRecurrentes['errores'] = [];
    let actualizados = 0;

    // Coarse progress signal for the frontend to poll while this request is
    // in flight — see ProgresoImportacionService's own note.
    const total = dto.filas.length;
    const intervalo = this.progreso.intervalo(total);
    await this.progreso.iniciar(coPropertyId, 'valores-recurrentes', total);

    try {
      for (const [indice, fila] of dto.filas.entries()) {
        try {
          if (fila.codigoCopropiedad !== copropiedad.code) {
            throw new Error(
              `El código de copropiedad "${fila.codigoCopropiedad}" no coincide con el de la copropiedad activa (${copropiedad.code})`,
            );
          }

          const inmueble = await this.inmuebles
            .findOne({ coPropertyId, code: fila.codigo })
            .exec();
          if (!inmueble) {
            throw new Error(
              `No existe un inmueble con el código ${fila.codigo} en esta copropiedad`,
            );
          }

          await this.guardar(inmueble._id.toString(), {
            valores: fila.valores,
          });
          actualizados += 1;
        } catch (err) {
          errores.push({
            fila: indice + 1,
            codigo: fila.codigo ?? null,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }

        const completadas = indice + 1;
        if (completadas % intervalo === 0 || completadas === total) {
          await this.progreso.actualizar(
            coPropertyId,
            'valores-recurrentes',
            completadas,
            total,
          );
        }
      }
    } finally {
      await this.progreso.finalizar(coPropertyId, 'valores-recurrentes');
    }

    return { total: dto.filas.length, actualizados, errores };
  }

  /** Null while no bulk valores-recurrentes import is currently running for
   *  the active coproperty — see `ProgresoImportacionService.obtener`. */
  async obtenerProgresoImportacion(): Promise<ProgresoActual | null> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.progreso.obtener(coPropertyId, 'valores-recurrentes');
  }
}
