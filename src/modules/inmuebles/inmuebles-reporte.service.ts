// src/modules/inmuebles/inmuebles-reporte.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { generarPdfListadoInmuebles } from '../../common/pdf/inmuebles-listado-pdf';
import type { RespuestaListadoInmuebles } from '../../contracts';

/** The shape `holderId` arrives in when the query populated it — wider than
 *  `inmuebles.mapper.ts`'s own `titularDe` pick, since this roster needs the
 *  raw name parts to build its own apellido-first display string (see
 *  `nombreListadoDe`) instead of reusing `Tercero.name`'s stored order. */
type TitularPoblado = {
  name: string;
  personType: 'natural' | 'juridica';
  firstName: string | null;
  firstLastName: string | null;
  secondLastName: string | null;
  businessName: string | null;
};

/**
 * "Apellido1 Apellido2 Nombre1" for a natural person — deliberately
 * SHORTER than `Tercero.name`'s own stored order (which also includes
 * `middleName`/segundo nombre), and surname-first (product decision,
 * 2026-09-20): a roster row is one printed/screen line, and the surname is
 * what identifies someone at a glance in a list sorted by unit, not their
 * full legal name — `Tercero.name` itself is untouched, still what
 * Factura/Recibo/every DIAN-facing document prints. `businessName` for a
 * legal entity has no "surname" to lead with, so it's used as-is. Falls
 * back to `Tercero.name` only if every relevant part is somehow null (a
 * titular saved before these fields existed, or with a blank name).
 */
function nombreListadoDe(holder: TitularPoblado | null): string | null {
  if (!holder) return null;
  if (holder.personType === 'juridica') {
    return holder.businessName || holder.name;
  }
  const partes = [
    holder.firstLastName,
    holder.secondLastName,
    holder.firstName,
  ].filter((p): p is string => Boolean(p));
  return partes.length > 0 ? partes.join(' ') : holder.name;
}

/** One active unit, already joined with its recurring cargo amounts —
 *  shared by the PDF and JSON/Excel roster, so the two never drift apart. */
interface ItemListado {
  codigo: string;
  titular: string | null;
  area: number | null;
  coeficiente: number | null;
  /** Keyed by `conceptoId`. */
  valores: Record<string, number>;
}

/**
 * Builds the "Listado de Inmuebles" roster: one row per active unit, with
 * its código, titular, área, coeficiente, and one column per recurring
 * charge — a separate service from `InmueblesService` because assembling a
 * multi-collection report is a different concern from unit CRUD, and giving
 * it its own constructor means neither grows dependencies the other
 * doesn't need.
 */
@Injectable()
export class InmueblesReporteService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /** Shared assembly for the PDF and JSON/Excel roster — the only
   *  difference between the two is the shape their caller renders it into. */
  private async construirListado(): Promise<{
    copropiedad: CopropiedadDocument;
    items: ItemListado[];
    conceptos: { id: string; nombre: string }[];
  }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const [copropiedad, inmuebles, conceptos, valores] = await Promise.all([
      this.copropiedades.findById(coPropertyId).exec(),
      this.inmuebles
        .find({ coPropertyId, status: 'active' })
        .sort({ code: 1 })
        .populate(
          'holderId',
          'name personType firstName firstLastName secondLastName businessName',
        )
        .exec(),
      // `intereses` excluded — it is computed from overdue balances, never a
      // flat monthly amount, so it has no column here (same reasoning as
      // the old `ValoresRecurrentesService.obtener` before it started
      // listing it for context on the per-unit screen; a printed roster has
      // no per-unit "calculado automáticamente" note to hang it on).
      this.conceptos
        .find({ coPropertyId, kind: { $ne: 'intereses' } })
        .sort({ sortOrder: 1 })
        .exec(),
      this.valoresRecurrentes.find({ coPropertyId }).exec(),
    ]);

    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const valoresPorInmueble = new Map<string, Map<string, number>>();
    for (const v of valores) {
      const inmuebleId = v.inmuebleId.toString();
      const mapa =
        valoresPorInmueble.get(inmuebleId) ?? new Map<string, number>();
      mapa.set(v.conceptoId.toString(), v.amount);
      valoresPorInmueble.set(inmuebleId, mapa);
    }

    const items = inmuebles.map((inm) => {
      const holder = inm.holderId as unknown as TitularPoblado | null;
      const propios = valoresPorInmueble.get(inm._id.toString());
      const valoresPorConcepto: Record<string, number> = {};
      for (const concepto of conceptos) {
        valoresPorConcepto[concepto._id.toString()] =
          propios?.get(concepto._id.toString()) ?? 0;
      }
      return {
        codigo: inm.code,
        titular: nombreListadoDe(holder),
        area: inm.area,
        coeficiente: inm.participationFactor,
        valores: valoresPorConcepto,
      };
    });

    const conceptosParaPdf = conceptos.map((c) => ({
      id: c._id.toString(),
      nombre: c.name,
    }));

    return { copropiedad, items, conceptos: conceptosParaPdf };
  }

  async generarListadoPdf(): Promise<Uint8Array> {
    const { copropiedad, items, conceptos } = await this.construirListado();
    // The PDF renderer prints an empty titular as "", never `null` — kept
    // as its own mapping here so the JSON/Excel roster below can tell
    // "sin titular" apart from an actual empty string.
    const itemsParaPdf = items.map((i) => ({ ...i, titular: i.titular ?? '' }));
    return generarPdfListadoInmuebles(copropiedad, itemsParaPdf, conceptos);
  }

  /** Same roster as `generarListadoPdf`, as JSON — what the Excel export
   *  button builds its workbook from. */
  async obtenerListado(): Promise<RespuestaListadoInmuebles> {
    const { copropiedad, items, conceptos } = await this.construirListado();
    return {
      copropiedadCodigo: copropiedad.code,
      conceptos: conceptos.map((c) => ({ conceptoId: c.id, nombre: c.nombre })),
      items,
    };
  }
}
