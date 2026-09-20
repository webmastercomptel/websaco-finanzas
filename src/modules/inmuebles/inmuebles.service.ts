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
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import { resolverNombreTercero } from '../../common/utils/tercero-name.utils';
import { CatalogosService } from '../catalogos/catalogos.service';
import { InmueblesEliminacionService } from './inmuebles-eliminacion.service';
import {
  ProgresoImportacionService,
  type ProgresoActual,
} from './progreso-importacion.service';
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
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
    private readonly catalogos: CatalogosService,
    private readonly eliminacion: InmueblesEliminacionService,
    private readonly progreso: ProgresoImportacionService,
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
    // Every unit in a coproperty is active by definition — there is no
    // `estado` filter to accept here anymore (see `ActualizarInmuebleDto`'s
    // own note). `status` stays `active` on every document Mongo actually
    // holds; this still names it explicitly rather than dropping the clause,
    // matching `LotesFacturacionService`'s own billing-eligibility query.
    const filtro: Record<string, unknown> = { coPropertyId, status: 'active' };

    if (query.buscar) {
      // Escaped: a search box is user input, and an unescaped regex lets a
      // stray "(" throw, or a crafted one pin the database at 100%.
      const regex = { $regex: escapeRegex(query.buscar), $options: 'i' };
      // The DTO promises "matches unit code or holder name", but the holder's
      // name lives on a separate Tercero, not on the Inmueble document — so
      // matching it means resolving which terceros match first, then OR-ing
      // that into the unit filter alongside the code match.
      const terceroIds = await this.terceros
        .find({ coPropertyId, name: regex })
        .distinct('_id')
        .exec();
      filtro.$or = [
        { code: regex },
        ...(terceroIds.length ? [{ holderId: { $in: terceroIds } }] : []),
      ];
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
        { returnDocument: 'after' },
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
   * REPLACES the roster, on purpose: every import first wipes every unit of
   * the active coproperty that can be wiped (see
   * `InmueblesEliminacionService.eliminarTodosEliminables`), then loads the
   * file as if into an empty building. A unit with a Factura survives the
   * wipe untouched — the same guard `eliminar` applies one at a time — and
   * its code is reported back in `bloqueadosPorFactura` rather than silently
   * kept, since the file might otherwise expect to recreate it.
   *
   * Rows are independent. One bad code or a repeated identification fails
   * only that row and keeps going, because asking somebody to re-upload a
   * 400-row file over three typos is not a serious answer.
   *
   * The one exception: `codigoCopropiedad` is checked against the WHOLE file
   * before anything is wiped — see `FilaImportarInmuebleDto.codigoCopropiedad`'s
   * own note. A file meant for a different building must never get the
   * chance to erase this one's roster, so any row carrying the wrong code
   * aborts the entire import with zero deletions, rather than being skipped
   * like an ordinary bad row.
   */
  async importar(
    dto: ImportarInmueblesDto,
  ): Promise<ResultadoImportacionInmuebles> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap (see
    // backend/CLAUDE.md's own note on this exact mistake).
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const erroresCodigo: ResultadoImportacionInmuebles['errores'] = [];
    dto.filas.forEach((fila, indice) => {
      if (fila.codigoCopropiedad !== copropiedad.code) {
        erroresCodigo.push({
          fila: indice + 1,
          codigo: fila.codigo ?? null,
          mensaje: `El código de copropiedad "${fila.codigoCopropiedad}" no coincide con el de la copropiedad activa (${copropiedad.code})`,
        });
      }
    });
    if (erroresCodigo.length > 0) {
      return {
        total: dto.filas.length,
        creados: 0,
        errores: erroresCodigo,
        eliminadosAntes: 0,
        bloqueadosPorFactura: [],
      };
    }

    const { eliminados, bloqueados } =
      await this.eliminacion.eliminarTodosEliminables();
    const errores: ResultadoImportacionInmuebles['errores'] = [];
    let creados = 0;

    // Coarse progress signal for the frontend to poll while this request is
    // in flight — see ProgresoImportacionService's own note. Cleared in
    // `finally` so a thrown error never leaves a stuck row behind.
    const total = dto.filas.length;
    const intervalo = this.progreso.intervalo(total);
    await this.progreso.iniciar(coPropertyId, 'inmuebles', total);

    try {
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
            reference: fila.referencia,
            block: fila.bloque,
            zone: fila.zona,
            usage: fila.uso,
            area: fila.area,
            participationFactor: fila.coeficiente,
            holderId,
            holderKind: fila.tipoTitular ?? 'propietario',
            holderResides: fila.resideEnElInmueble ?? false,
            collectionStatus: fila.estadoCartera ?? 'vigente',
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

        const completadas = indice + 1;
        if (completadas % intervalo === 0 || completadas === total) {
          await this.progreso.actualizar(
            coPropertyId,
            'inmuebles',
            completadas,
            total,
          );
        }
      }
    } finally {
      await this.progreso.finalizar(coPropertyId, 'inmuebles');
    }

    return {
      total: dto.filas.length,
      creados,
      errores,
      eliminadosAntes: eliminados,
      bloqueadosPorFactura: bloqueados,
    };
  }

  /** Null while no import is currently running for the active coproperty —
   *  see `ProgresoImportacionService.obtener`. */
  async obtenerProgresoImportacion(): Promise<ProgresoActual | null> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.progreso.obtener(coPropertyId, 'inmuebles');
  }

  /**
   * Reuses an existing party by identification when one matches, creates a
   * new one when the row names somebody without a match, or leaves the unit
   * without a titular when the row carries neither — a building loaded
   * before its ownership papers is the ordinary case here, not an error.
   *
   * A reused party is also REFRESHED with whatever this row provides —
   * never left as-is. Every import wipes the unit roster but never touches
   * `Tercero` (see `InmueblesEliminacionService`), so a second import of the
   * same building reuses the same parties every time; if that reuse only
   * returned the id, a corrected file could never fix a party's own data
   * (address, city, document type…) once it existed — exactly the bug a
   * repeated import is supposed to be able to fix.
   *
   * `personType` is inferred from which name columns the row filled in
   * (`razonSocialTitular` → jurídica, otherwise natural) — the template has
   * no separate "tipo de persona" column, since a row that names nobody at
   * all already leaves the unit without a titular above.
   *
   * `tipoIdentificacionTitular`/`ciudadTitular` are DIAN/DANE codes, the same
   * ones the manual Titular form's dropdowns write — validated against the
   * same static catalog (`CatalogosService`) rather than trusted as free
   * text, since a typo here would silently save a code no DIAN reader
   * recognizes. A bad code fails only this row, same as a repeated codigo.
   */
  private async resolverTitular(
    coPropertyId: Types.ObjectId,
    fila: FilaImportarInmuebleDto,
  ): Promise<Types.ObjectId | undefined> {
    const personType = fila.razonSocialTitular ? 'juridica' : 'natural';
    const nombre = resolverNombreTercero({
      tipoPersona: personType,
      nombre: fila.nombreTitular,
      nom1: fila.nom1Titular,
      nom2: fila.nom2Titular,
      ape1: fila.ape1Titular,
      ape2: fila.ape2Titular,
      razonSocial: fila.razonSocialTitular,
    });

    if (
      fila.tipoIdentificacionTitular &&
      !this.catalogos
        .listarTiposIdentificacion()
        .some((t) => t.codigo === fila.tipoIdentificacionTitular)
    ) {
      throw new Error(
        `El código de tipo de identificación "${fila.tipoIdentificacionTitular}" no existe en el catálogo DIAN`,
      );
    }

    let ciudad: string | undefined;
    let ciudadDepartamento: string | undefined;
    if (fila.ciudadTitular) {
      const encontrada = this.catalogos
        .listarCiudades()
        .find((c) => c.codigo === fila.ciudadTitular);
      if (!encontrada) {
        throw new Error(
          `El código de ciudad "${fila.ciudadTitular}" no existe en el catálogo DANE`,
        );
      }
      ciudad = encontrada.nombre;
      ciudadDepartamento = encontrada.departamentoCodigo;
    }

    if (fila.numeroIdentificacionTitular) {
      const existente = await this.terceros
        .findOne({
          coPropertyId,
          identificationNumber: fila.numeroIdentificacionTitular,
        })
        .exec();
      if (existente) {
        await this.actualizarTitularExistente(existente._id, {
          personType: nombre ? personType : undefined,
          nombre,
          fila,
          ciudad,
          ciudadDepartamento,
        });
        return existente._id;
      }
    }

    if (!nombre) return undefined;

    const creado = await this.terceros.create({
      coPropertyId,
      personType,
      name: nombre,
      firstName: fila.nom1Titular,
      middleName: fila.nom2Titular,
      firstLastName: fila.ape1Titular,
      secondLastName: fila.ape2Titular,
      businessName: fila.razonSocialTitular,
      identificationType: fila.tipoIdentificacionTitular,
      identificationNumber: fila.numeroIdentificacionTitular,
      identificationVerificationDigit: fila.digitoVerificacionTitular,
      email: fila.emailTitular,
      phone: fila.telefonoTitular,
      address: fila.direccionTitular,
      city: ciudad,
      cityCode: fila.ciudadTitular,
      cityDepartmentCode: ciudadDepartamento,
    });
    return creado._id;
  }

  /**
   * Merges a row's fields into an already-existing party — only the ones
   * this row actually sent, same "don't clear what wasn't touched" rule
   * `aDocumento` follows for the unit itself. `nombre`/`personType` are
   * skipped when the row named nobody (`resolverNombreTercero` returned
   * null) — a row that only repeats a known identification number must not
   * blank out a name it never mentioned.
   */
  private async actualizarTitularExistente(
    id: Types.ObjectId,
    datos: {
      personType: 'natural' | 'juridica' | undefined;
      nombre: string | null;
      fila: FilaImportarInmuebleDto;
      ciudad: string | undefined;
      ciudadDepartamento: string | undefined;
    },
  ): Promise<void> {
    const { personType, nombre, fila, ciudad, ciudadDepartamento } = datos;
    const cambios: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) cambios[clave] = valor;
    };

    set('personType', personType);
    set('name', nombre ?? undefined);
    set('firstName', fila.nom1Titular);
    set('middleName', fila.nom2Titular);
    set('firstLastName', fila.ape1Titular);
    set('secondLastName', fila.ape2Titular);
    set('businessName', fila.razonSocialTitular);
    set('identificationType', fila.tipoIdentificacionTitular);
    set('identificationVerificationDigit', fila.digitoVerificacionTitular);
    set('email', fila.emailTitular);
    set('phone', fila.telefonoTitular);
    set('address', fila.direccionTitular);
    set('city', ciudad);
    set('cityCode', fila.ciudadTitular);
    set('cityDepartmentCode', ciudadDepartamento);

    if (Object.keys(cambios).length === 0) return;
    await this.terceros.updateOne({ _id: id }, { $set: cambios }).exec();
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
    set('reference', dto.referencia);
    set('block', dto.bloque);
    set('zone', dto.zona);
    set('usage', dto.uso);
    set('area', dto.area);
    set('participationFactor', dto.coeficiente);
    set('holderId', dto.titularId);
    set('holderKind', dto.tipoTitular);
    set('holderResides', dto.resideEnElInmueble);
    set('collectionStatus', dto.estadoCartera);
    set('contactName', dto.contacto);
    set('notes', dto.observaciones);

    return doc;
  }
}
