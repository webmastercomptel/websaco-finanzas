import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../../database/schemas/conceptos/valor-recurrente.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import type { LoteFacturacion as LoteContract } from '../../contracts';
import { toLote } from './lotes.mapper';
import type { CrearLoteDto } from './dto/crear-lote.dto';
import type { NovedadFilaDto } from './dto/cargar-novedades.dto';
import type { ResultadoCargaNovedades } from '../../contracts';

/**
 * CANONICAL CONSTRUCTOR — pinned here and never changed by a later task in
 * this plan. `terceros` and `copropiedades` are unused until Tasks 9 and 10
 * respectively, but declaring the full shape now means every later task only
 * adds methods, never edits this parameter list — the single biggest source
 * of silent test/implementation drift in a plan built task-by-task. Every
 * test in Tasks 6, 7, 9, and 10 constructs this class with all twelve
 * arguments, in this exact order, using `{} as never` for whichever ones
 * that particular test does not exercise.
 */
@Injectable()
export class LotesFacturacionService {
  constructor(
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly periodo: PeriodoService,
    private readonly numeracion: NumeracionService,
  ) {}

  /**
   * Starts (or would-be-resumes) a billing run. Rejects outright if the
   * coproperty already has one in `borrador` or `liquidado` — see the
   * partial unique index on LoteFacturacion for why only one may exist.
   */
  async crear(accountId: string, dto: CrearLoteDto): Promise<LoteContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const yaHayUno = await this.lotes
      .exists({
        coPropertyId,
        status: { $in: ['borrador', 'liquidado'] },
      })
      .exec();
    if (yaHayUno) {
      throw new ConflictException(
        'Ya hay un lote de facturación en curso para esta copropiedad. ' +
          'Consolidalo o esperá a que se resuelva antes de crear uno nuevo.',
      );
    }

    const numero = await this.numeracion.siguienteLote(coPropertyId.toString());

    const creado = await this.lotes.create({
      coPropertyId,
      number: numero,
      status: 'borrador',
      billingDate: new Date(dto.fechaFacturacion),
      dueDate: new Date(dto.fechaVencimiento),
      periodStart: new Date(dto.periodoDesde),
      periodEnd: new Date(dto.periodoHasta),
      earlyPaymentDiscount: dto.descuentoProntoPago ?? 0,
      discountGraceDays: dto.diasGraciaDescuento ?? 0,
      lateInterestRate: dto.interesMora ?? 0,
      lateInterestCap: dto.topeInteresMora ?? null,
      generatedBy: accountId,
    });

    return toLote(creado);
  }

  /**
   * Uploads one-off charges for THIS run only — never written into
   * ValorRecurrente, the standing monthly template. Each row is resolved
   * independently by human-readable identifiers (unit código, concept
   * nombre), the same shape as the Inmuebles bulk import: a row that cannot
   * be resolved is reported and skipped, the rest of the file still loads.
   * A fresh upload REPLACES the Lote's previous novedades, since re-uploading
   * a corrected file is the expected flow, not accumulating duplicates.
   */
  async cargarNovedades(
    loteId: string,
    filas: NovedadFilaDto[],
  ): Promise<ResultadoCargaNovedades> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const errores: ResultadoCargaNovedades['errores'] = [];
    const novedades: Record<string, unknown>[] = [];

    for (const [indice, fila] of filas.entries()) {
      const inmueble = await this.inmuebles
        .findOne({ coPropertyId, code: fila.inmuebleCodigo })
        .exec();
      if (!inmueble) {
        errores.push({
          fila: indice + 1,
          mensaje: `No se encontró el inmueble con código "${fila.inmuebleCodigo}"`,
        });
        continue;
      }

      const concepto = await this.conceptos
        .findOne({ coPropertyId, name: fila.nombreConcepto })
        .exec();
      if (!concepto) {
        errores.push({
          fila: indice + 1,
          mensaje: `No se encontró el cargo "${fila.nombreConcepto}"`,
        });
        continue;
      }

      novedades.push({
        inmuebleId: inmueble._id,
        conceptoId: concepto._id,
        amount: fila.monto,
        note: fila.observacion?.trim() ? fila.observacion : null,
      });
    }

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: loteId, coPropertyId },
        { $set: { adjustments: novedades } },
        { new: true },
      )
      .exec();
    if (!actualizado) {
      throw new NotFoundException(`No se encontró el lote ${loteId}`);
    }

    return { total: filas.length, cargadas: novedades.length, errores };
  }
}
