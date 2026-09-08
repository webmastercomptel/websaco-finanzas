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
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../../database/schemas/conceptos/valor-recurrente.schema';
import type { ValorRecurrente as ValorRecurrenteContract } from '../../contracts';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { toValorRecurrente } from './valores-recurrentes.mapper';
import type { GuardarValoresRecurrentesDto } from './dto/guardar-valores-recurrentes.dto';

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
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
    private readonly tenant: TenantContextService,
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
}
