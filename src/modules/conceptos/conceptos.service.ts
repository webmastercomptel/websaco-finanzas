// src/modules/conceptos/conceptos.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
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
 * Scoped by an explicit `copropiedadId` route param, never
 * TenantContextService: PlatformAdminGuard is what lets an operator edit ANY
 * building's concepts from the platform catalogue — the same shape
 * CopropiedadesService itself uses, and for the same reason.
 *
 * This is a temporary access shape, not the final one: see the CASL subject
 * `ConceptoCobro` already reserved in permission-map.ts. Once a building's own
 * administrator gets a screen for this, it will read the id from
 * TenantContextService instead of a route param and check
 * `conceptos.gestionar` instead of PlatformAdminGuard.
 */
@Injectable()
export class ConceptosService {
  constructor(
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
  ) {}

  async findAll(copropiedadId: string): Promise<ConceptoContract[]> {
    const documentos = await this.conceptos
      .find({ coPropertyId: copropiedadId })
      .sort({ sortOrder: 1 })
      .exec();
    return documentos.map(toConcepto);
  }

  async create(
    copropiedadId: string,
    dto: CrearConceptoDto,
  ): Promise<ConceptoContract> {
    const yaExiste = await this.conceptos
      .exists({ coPropertyId: copropiedadId, name: dto.nombre })
      .exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe un cargo llamado "${dto.nombre}" en esta copropiedad`,
      );
    }
    await this.verificarUnicidadPorTipo(copropiedadId, dto.tipo);

    const creado = await this.conceptos.create({
      coPropertyId: copropiedadId,
      ...this.aDocumento(dto),
    });
    return toConcepto(creado);
  }

  /**
   * Edits a concept. There is no delete: `activo: false` is how one stops
   * being charged going forward without orphaning the documents that already
   * reference it.
   */
  async update(
    copropiedadId: string,
    id: string,
    dto: ActualizarConceptoDto,
  ): Promise<ConceptoContract> {
    if (dto.nombre) {
      const chocaConOtro = await this.conceptos
        .exists({
          coPropertyId: copropiedadId,
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
      await this.verificarUnicidadPorTipo(copropiedadId, dto.tipo, id);
    }

    const actualizado = await this.conceptos
      .findOneAndUpdate(
        { _id: id, coPropertyId: copropiedadId },
        { $set: this.aDocumento(dto) },
        { new: true },
      )
      .exec();

    if (!actualizado) {
      throw new NotFoundException(`No se encontró el cargo ${id}`);
    }
    return toConcepto(actualizado);
  }

  /**
   * `administracion` and `intereses` may each appear at most once per
   * building — the schema's partial unique index enforces this too, but
   * failing here gives a message an operator can act on instead of a raw
   * duplicate-key error.
   */
  private async verificarUnicidadPorTipo(
    copropiedadId: string,
    tipo: string | undefined,
    idAExcluir?: string,
  ): Promise<void> {
    if (tipo !== 'administracion' && tipo !== 'intereses') return;

    const filtro: Record<string, unknown> = {
      coPropertyId: copropiedadId,
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
    set('sortOrder', dto.orden);
    set('accountingIncomeAccount', dto.cuentaContableIngreso);
    if ('activo' in dto) set('active', dto.activo);

    return doc;
  }
}
