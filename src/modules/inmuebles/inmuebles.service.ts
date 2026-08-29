// src/modules/inmuebles/inmuebles.service.ts
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
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type {
  Inmueble as InmuebleContract,
  Paginado,
  ResultadoImportacionInmuebles,
} from '../../contracts';
import { toInmueble } from './inmuebles.mapper';
import type { ListarInmueblesDto } from './dto/listar-inmuebles.dto';
import type {
  ActualizarInmuebleDto,
  CrearInmuebleDto,
} from './dto/guardar-inmueble.dto';
import type {
  FilaImportarInmuebleDto,
  ImportarInmueblesDto,
} from './dto/importar-inmuebles.dto';

@Injectable()
export class InmueblesService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Lists the units of the active coproperty.
   *
   * The filter starts from the tenant and nothing else can remove it — see the
   * tenancy law. Every other condition is added on top.
   */
  async findAll(
    query: ListarInmueblesDto,
  ): Promise<Paginado<InmuebleContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };

    // Default to the ones that are actually in use: a listing that opens with
    // deactivated units mixed in makes people distrust the count.
    if (query.estado !== 'todos') {
      filtro.status = query.estado === 'inactivo' ? 'inactive' : 'active';
    }

    if (query.buscar) {
      // Escaped: a search box is user input, and an unescaped regex lets a
      // stray "(" throw, or a crafted one pin the database at 100%.
      filtro.code = { $regex: escapeRegex(query.buscar), $options: 'i' };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    // Counted with the same filter, in parallel: a total that disagrees with
    // the rows turns pagination into a lie.
    const [documentos, total] = await Promise.all([
      this.inmuebles
        .find(filtro)
        .populate('holderId', 'name identificationNumber')
        .sort({ code: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.inmuebles.countDocuments(filtro).exec(),
    ]);

    return {
      items: documentos.map(toInmueble),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * One unit, scoped to the active coproperty.
   *
   * The tenant is part of the query, not checked afterwards: fetching by id and
   * then comparing would still have read another building's row, and the day
   * somebody forgets the comparison it is served.
   */
  async findOne(id: string): Promise<InmuebleContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const documento = await this.inmuebles
      .findOne({ _id: id, coPropertyId })
      .populate('holderId', 'name identificationNumber')
      .exec();

    if (!documento) {
      // Deliberately the same answer as "does not exist". Telling a caller that
      // an id exists but belongs elsewhere confirms the existence of another
      // building's data.
      throw new NotFoundException(`No se encontró el inmueble ${id}`);
    }

    return toInmueble(documento);
  }

  /**
   * Creates a unit in the active coproperty.
   *
   * The tenant is taken from the context and written here, never read from the
   * body — a caller must not be able to create a unit inside another building.
   */
  async create(dto: CrearInmuebleDto): Promise<InmuebleContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const yaExiste = await this.inmuebles
      .exists({ coPropertyId, code: dto.codigo })
      .exec();
    if (yaExiste) {
      // Checked here as well as by the unique index, so the person gets a
      // sentence instead of a driver error naming an index they never saw.
      throw new ConflictException(
        `Ya existe un inmueble con el código ${dto.codigo} en esta copropiedad`,
      );
    }

    const creado = await this.inmuebles.create({
      ...this.aDocumento(dto),
      coPropertyId,
    });

    // Re-read populated: the created document holds a raw id for the holder,
    // and the contract promises the holder's name.
    return this.findOne(creado._id.toString());
  }

  /**
   * Edits a unit of the active coproperty.
   *
   * Only the fields present in the patch are touched. A unit is retired by
   * setting `estado` to `inactivo`; there is deliberately no delete, because
   * removing a unit orphans every document ever issued against it.
   */
  async update(
    id: string,
    dto: ActualizarInmuebleDto,
  ): Promise<InmuebleContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (dto.codigo) {
      // Another unit in the same building already using the code. `$ne`
      // excludes this one, so saving without changing the code is not a clash
      // with itself.
      const chocaConOtro = await this.inmuebles
        .exists({ coPropertyId, code: dto.codigo, _id: { $ne: id } })
        .exec();
      if (chocaConOtro) {
        throw new ConflictException(
          `Ya existe otro inmueble con el código ${dto.codigo} en esta copropiedad`,
        );
      }
    }

    const actualizado = await this.inmuebles
      .findOneAndUpdate(
        // The tenant is part of the match, not a check afterwards: this is what
        // stops an id from another building being edited.
        { _id: id, coPropertyId },
        { $set: this.aDocumento(dto) },
        { new: true },
      )
      .exec();

    if (!actualizado) {
      throw new NotFoundException(`No se encontró el inmueble ${id}`);
    }

    return this.findOne(actualizado._id.toString());
  }

  /**
   * Loads a building's roster in one act: a unit and, inline, the party that
   * answers for it — the same "one concept, two tables" pair `findOne`
   * returns joined, just going in instead of coming out.
   *
   * Rows are independent. One bad code or a repeated identification fails
   * only that row and keeps going, because asking somebody to re-upload a
   * 400-row file over three typos is not a serious answer.
   */
  async importar(
    dto: ImportarInmueblesDto,
  ): Promise<ResultadoImportacionInmuebles> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const errores: ResultadoImportacionInmuebles['errores'] = [];
    let creados = 0;

    for (const [indice, fila] of dto.filas.entries()) {
      try {
        const yaExiste = await this.inmuebles
          .exists({ coPropertyId, code: fila.codigo })
          .exec();
        if (yaExiste) {
          throw new Error(
            `Ya existe un inmueble con el código ${fila.codigo} en esta copropiedad`,
          );
        }

        const holderId = await this.resolverTitular(coPropertyId, fila);

        await this.inmuebles.create({
          coPropertyId,
          code: fila.codigo,
          block: fila.bloque,
          zone: fila.zona,
          usage: fila.uso,
          costCentre: fila.centroCostos,
          area: fila.area,
          participationFactor: fila.coeficiente,
          holderId,
          holderKind: fila.tipoTitular ?? 'propietario',
          holderResides: fila.resideEnElInmueble ?? false,
          collectionStatus: fila.estadoCartera ?? 'al_dia',
          contactName: fila.contacto,
          notes: fila.observaciones,
        });
        creados += 1;
      } catch (err) {
        errores.push({
          fila: indice + 1,
          codigo: fila.codigo ?? null,
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
        });
      }
    }

    return { total: dto.filas.length, creados, errores };
  }

  /**
   * Reuses an existing party by identification when one matches, creates a
   * new one when the row names somebody without a match, or leaves the unit
   * without a titular when the row carries neither — a building loaded
   * before its ownership papers is the ordinary case here, not an error.
   */
  private async resolverTitular(
    coPropertyId: Types.ObjectId,
    fila: FilaImportarInmuebleDto,
  ): Promise<Types.ObjectId | undefined> {
    if (fila.numeroIdentificacionTitular) {
      const existente = await this.terceros
        .findOne({
          coPropertyId,
          identificationNumber: fila.numeroIdentificacionTitular,
        })
        .exec();
      if (existente) return existente._id;
    }

    if (!fila.nombreTitular) return undefined;

    const creado = await this.terceros.create({
      coPropertyId,
      personType: 'natural',
      name: fila.nombreTitular,
      identificationType: fila.tipoIdentificacionTitular,
      identificationNumber: fila.numeroIdentificacionTitular,
      identificationVerificationDigit: fila.digitoVerificacionTitular,
      email: fila.emailTitular,
      phone: fila.telefonoTitular,
    });
    return creado._id;
  }

  /**
   * Translates the Spanish payload into the English document shape.
   *
   * Only keys the caller actually sent are included. Spreading the DTO whole
   * would write `undefined` over fields nobody meant to clear — the classic way
   * a patch quietly erases data.
   */
  private aDocumento(dto: ActualizarInmuebleDto): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('code', dto.codigo);
    set('block', dto.bloque);
    set('zone', dto.zona);
    set('usage', dto.uso);
    set('costCentre', dto.centroCostos);
    set('area', dto.area);
    set('participationFactor', dto.coeficiente);
    set('holderId', dto.titularId);
    set('holderKind', dto.tipoTitular);
    set('holderResides', dto.resideEnElInmueble);
    set('collectionStatus', dto.estadoCartera);
    set('contactName', dto.contacto);
    set('notes', dto.observaciones);
    if (dto.estado !== undefined) {
      doc.status = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    return doc;
  }
}
