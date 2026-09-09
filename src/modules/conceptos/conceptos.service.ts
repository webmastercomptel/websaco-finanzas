// src/modules/conceptos/conceptos.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  ValorRecurrente,
  ValorRecurrenteDocument,
} from '../../database/schemas/conceptos/valor-recurrente.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import type { ConceptoCobro as ConceptoContract } from '../../contracts';
import { toConcepto } from './conceptos.mapper';
import type {
  ActualizarConceptoDto,
  CrearConceptoDto,
} from './dto/guardar-concepto.dto';

/**
 * Manages the billing concepts ("Cargos") one coproperty can charge —
 * administration fee, late interest, fines, parking. Replaces the legacy
 * system's twelve fixed slots with rows a building declares as many of as it
 * needs; see the note on the ConceptoCobro schema.
 *
 * Takes an explicit `copropiedadId` rather than reading
 * `TenantContextService` itself: `CopropiedadesService.create()` calls
 * `create()` here to seed the three system concepts for a brand-new building,
 * before that building has ever been an active tenant on any request — there
 * is no CLS context to read yet. `ConceptosController` is what resolves the
 * id from `TenantContextService` for every real end-user request (CASL
 * subject `ConceptoCobro`, see the note there); this service stays usable by
 * either caller.
 */
@Injectable()
export class ConceptosService {
  constructor(
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(ValorRecurrente.name)
    private readonly valoresRecurrentes: Model<ValorRecurrenteDocument>,
  ) {}

  async findAll(copropiedadId: string): Promise<ConceptoContract[]> {
    const oid = new Types.ObjectId(copropiedadId);
    const documentos = await this.conceptos
      .find({ coPropertyId: oid })
      .populate('cuentaDebitoId', 'code')
      .populate('cuentaCreditoId', 'code')
      .populate('cuentaImpuestoId', 'code')
      .sort({ sortOrder: 1 })
      .exec();
    return documentos.map(toConcepto);
  }

  async create(
    copropiedadId: string,
    dto: CrearConceptoDto,
  ): Promise<ConceptoContract> {
    const oid = new Types.ObjectId(copropiedadId);
    const yaExiste = await this.conceptos
      .exists({ coPropertyId: oid, name: dto.nombre })
      .exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe un cargo llamado "${dto.nombre}" en esta copropiedad`,
      );
    }
    await this.verificarUnicidadPorTipo(oid, dto.tipo);

    const creado = await this.conceptos.create({
      coPropertyId: oid,
      sortOrder: await this.siguienteOrden(oid),
      ...this.aDocumento(dto),
    });
    return toConcepto(creado);
  }

  /**
   * `orden` is never client-supplied — it is display order, not a business
   * fact anyone types in, so the UI does not show a field for it at all.
   * Each new concept lands one past whatever the building already has.
   */
  private async siguienteOrden(coPropertyId: Types.ObjectId): Promise<number> {
    const [ultimo] = await this.conceptos
      .find({ coPropertyId })
      .sort({ sortOrder: -1 })
      .limit(1)
      .exec();
    return (ultimo?.sortOrder ?? 0) + 1;
  }

  /**
   * Edits a concept. The three system concepts (Administración, Intereses
   * por Mora, Multas) are editable like any other — only deleting them is
   * blocked, in `delete()` below.
   */
  async update(
    copropiedadId: string,
    id: string,
    dto: ActualizarConceptoDto,
  ): Promise<ConceptoContract> {
    const oid = new Types.ObjectId(copropiedadId);
    const existente = await this.conceptos
      .findOne({ _id: id, coPropertyId: oid })
      .exec();
    if (!existente) {
      throw new NotFoundException(`No se encontró el cargo ${id}`);
    }

    if (dto.nombre) {
      const chocaConOtro = await this.conceptos
        .exists({
          coPropertyId: oid,
          name: dto.nombre,
          _id: { $ne: id },
        })
        .exec();
      if (chocaConOtro) {
        throw new ConflictException(
          `Ya existe otro cargo llamado "${dto.nombre}" en esta copropiedad`,
        );
      }
    }
    if (dto.tipo) {
      await this.verificarUnicidadPorTipo(oid, dto.tipo, id);
    }

    const actualizado = await this.conceptos
      .findOneAndUpdate(
        { _id: id, coPropertyId: oid },
        { $set: this.aDocumento(dto) },
        { returnDocument: 'after' },
      )
      .exec();

    if (!actualizado) {
      throw new NotFoundException(`No se encontró el cargo ${id}`);
    }
    return toConcepto(actualizado);
  }

  /**
   * Deletes a concept. Two things make it un-deletable:
   *
   * - It is one of the three system concepts (Administración, Intereses por
   *   Mora, Multas) — the billing cycle depends on them existing.
   * - It has ever actually been used: a `SaldoCartera` row means some
   *   document already posted against it (recurring charge, novedad,
   *   interest, a Nota Crédito/Débito/Contable), and deleting it would leave
   *   that document's `conceptoId` pointing at nothing. A `ValorRecurrente`
   *   row means a unit is still actively configured to be charged this each
   *   cycle — deleting it would silently drop that charge from every future
   *   lote instead of erroring.
   *
   * Both checks are `coPropertyId`-scoped, same as everything else here.
   */
  async delete(copropiedadId: string, id: string): Promise<void> {
    const oid = new Types.ObjectId(copropiedadId);
    const existente = await this.conceptos
      .findOne({ _id: id, coPropertyId: oid })
      .exec();
    if (!existente) {
      throw new NotFoundException(`No se encontró el cargo ${id}`);
    }
    if (existente.isSystem) {
      throw new ConflictException('Los cargos de sistema no pueden eliminarse');
    }

    const conceptoId = new Types.ObjectId(id);
    const [enSaldos, enRecurrentes] = await Promise.all([
      this.saldos.exists({ coPropertyId: oid, conceptoId }).exec(),
      this.valoresRecurrentes.exists({ coPropertyId: oid, conceptoId }).exec(),
    ]);
    if (enSaldos) {
      throw new ConflictException(
        'Este cargo ya fue usado en documentos financieros y no puede eliminarse',
      );
    }
    if (enRecurrentes) {
      throw new ConflictException(
        'Este cargo todavía está asignado como valor recurrente a uno o más inmuebles',
      );
    }

    await this.conceptos.deleteOne({ _id: id, coPropertyId: oid }).exec();
  }

  /**
   * `administracion` and `intereses` may each appear at most once per
   * building — the schema's partial unique index enforces this too, but
   * failing here gives a message an operator can act on instead of a raw
   * duplicate-key error.
   */
  private async verificarUnicidadPorTipo(
    coPropertyId: Types.ObjectId,
    tipo: string | undefined,
    idAExcluir?: string,
  ): Promise<void> {
    if (tipo !== 'administracion' && tipo !== 'intereses') return;

    const filtro: Record<string, unknown> = {
      coPropertyId,
      kind: tipo,
    };
    if (idAExcluir) filtro._id = { $ne: idAExcluir };

    const yaExiste = await this.conceptos.exists(filtro).exec();
    if (yaExiste) {
      throw new ConflictException(
        `Esta copropiedad ya tiene un cargo de tipo "${tipo}"`,
      );
    }
  }

  /**
   * Translates the Spanish payload into the English document shape. Only keys
   * the caller actually sent are included — spreading the DTO whole would
   * write `undefined` over fields nobody meant to clear.
   */
  private aDocumento(
    dto: CrearConceptoDto | ActualizarConceptoDto,
  ): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('name', dto.nombre);
    set('kind', dto.tipo);
    set('taxRate', dto.tasaImpuesto);
    // `?? null` would run even when the caller never sent the field —
    // guarded by `in` so clearing an account is a deliberate empty string,
    // not an accidental wipe from an unrelated patch.
    if ('cuentaDebitoId' in dto) {
      set(
        'cuentaDebitoId',
        dto.cuentaDebitoId ? new Types.ObjectId(dto.cuentaDebitoId) : null,
      );
    }
    if ('cuentaCreditoId' in dto) {
      set(
        'cuentaCreditoId',
        dto.cuentaCreditoId ? new Types.ObjectId(dto.cuentaCreditoId) : null,
      );
    }
    if ('cuentaImpuestoId' in dto) {
      set(
        'cuentaImpuestoId',
        dto.cuentaImpuestoId ? new Types.ObjectId(dto.cuentaImpuestoId) : null,
      );
    }
    set('liquidaMora', dto.liquidaMora);
    set('availableAsNovedad', dto.cargaXls);
    if ('sistema' in dto) set('isSystem', dto.sistema);

    return doc;
  }
}
