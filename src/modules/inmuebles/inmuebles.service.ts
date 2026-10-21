// src/modules/inmuebles/inmuebles.service.ts
import {
  BadRequestException,
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
import { parseEmails } from '../../common/utils/email.utils';
import { CatalogosService } from '../catalogos/catalogos.service';
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
    const copropiedadId = this.tenant.resolveCoPropertyId();
    // Both `activo` and `inactivo` units show here (unlike
    // `LotesFacturacionService`'s own billing-eligibility query, which
    // filters to `status: 'active'` and only there — see `Inmueble.estado`'s
    // own contract note): a unit marked `inactivo` still has to be findable
    // and editable, if only to flip it back.
    const filtro: Record<string, unknown> = { copropiedadId };

    if (query.buscar) {
      // Escaped: a search box is user input, and an unescaped regex lets a
      // stray "(" throw, or a crafted one pin the database at 100%.
      const regex = { $regex: escapeRegex(query.buscar), $options: 'i' };
      // The DTO promises "matches unit code or holder name", but the holder's
      // name lives on a separate Tercero, not on the Inmueble document — so
      // matching it means resolving which terceros match first, then OR-ing
      // that into the unit filter alongside the code match.
      const terceroIds = await this.terceros
        .find({ copropiedadId, nombre: regex })
        .distinct('_id')
        .exec();
      filtro.$or = [
        { codigo: regex },
        ...(terceroIds.length ? [{ titularId: { $in: terceroIds } }] : []),
      ];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    // Counted with the same filter, in parallel: a total that disagrees with
    // the rows turns pagination into a lie.
    const [documentos, total] = await Promise.all([
      this.inmuebles
        .find(filtro)
        .populate('titularId', 'nombre numeroIdentificacion')
        .sort({ codigo: 1 })
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
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const documento = await this.inmuebles
      .findOne({ _id: id, copropiedadId })
      .populate('titularId', 'nombre numeroIdentificacion')
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
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const yaExiste = await this.inmuebles
      .exists(this.filtroCodigoDuplicado(copropiedadId, dto.codigo))
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
      copropiedadId,
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
   *
   * The `codigo` is immutable after creation: the other system links units by
   * it, so a change here would silently detach their holders. A different code
   * is a 400; the same code (the form resends it on every edit, possibly
   * padded) is ignored and never written. Because of that there is no
   * duplicate check here — the code cannot change, so it cannot newly clash.
   */
  async update(
    id: string,
    dto: ActualizarInmuebleDto,
  ): Promise<InmuebleContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // Tenant-scoped read first, so a unit of another building answers 404 even
    // when the patch carries a different code (400 would confirm the id exists).
    const guardado = await this.inmuebles
      .findOne({ _id: id, copropiedadId })
      .select('codigo')
      .lean()
      .exec();
    if (!guardado) {
      throw new NotFoundException(`No se encontró el inmueble ${id}`);
    }

    if (dto.codigo !== undefined && dto.codigo.trim() !== guardado.codigo) {
      throw new BadRequestException(
        'El código de un inmueble no se puede modificar después de crearlo.',
      );
    }

    const cambios = this.aDocumento(dto);
    delete cambios.codigo;

    const actualizado = await this.inmuebles
      .findOneAndUpdate(
        // The tenant is part of the match, not a check afterwards: this is what
        // stops an id from another building being edited.
        { _id: id, copropiedadId },
        { $set: cambios },
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
   * An UPSERT BY CODE that NEVER deletes. A row whose code already exists
   * (matched with the same tenant-scoped, case/whitespace-insensitive filter
   * `create` uses) patches that unit; a row of an unknown code creates it.
   * Loading a file is never destructive, because the previous design — wipe
   * every unit, then reload — was not atomic (one bad row left its unit
   * deleted and not recreated), guarded only against `Factura` although
   * Recibo / SaldoInicial / SaldoInicialAnticipo / notas / SaldoCartera also
   * reference `inmuebleId` (so a unit holding only opening balances could be
   * hard-deleted and orphan them), minted new `_id`s on every import, and made
   * an invoiced unit impossible to correct. Retiring units that are absent
   * from a file is a separate, explicit act (deferred, see the
   * `importar-inmuebles-upsert` change) — never a side effect of loading.
   *
   * Update rules, in short:
   * - Only the fields the row actually sent are written. A blank or
   *   whitespace-only cell counts as NOT sent, for the unit AND the titular
   *   (see `sinCeldasVacias`): the backend must not depend on the client
   *   dropping blanks, and an empty cell means "nothing to say", never
   *   "erase this".
   * - `codigo` is never written (immutable, WebSaco3 links units by it) and
   *   neither is `estado` (the row cannot carry it, and an inactive unit
   *   must stay inactive across a re-import of an exported file).
   * - There is no invoice guard: nothing is deleted, and the edit form edits
   *   invoiced units too.
   * - The titular follows `resolverTitular`, which also decides whether the
   *   unit's own party may be refreshed or a new one must be created.
   * - DIAN/DANE codes are validated before anything of that row is written.
   *
   * Rows are independent. One bad code or a malformed email fails only that
   * row and keeps going, because asking somebody to re-upload a 400-row file
   * over three typos is not a serious answer.
   *
   * The one exception: `codigoCopropiedad` is checked against the WHOLE file
   * before anything is written — see `FilaImportarInmuebleDto.codigoCopropiedad`'s
   * own note. A file meant for a different building must never get the
   * chance to patch this one's roster, so any row carrying the wrong code
   * aborts the entire import with zero writes, rather than being skipped
   * like an ordinary bad row.
   */
  async importar(
    dto: ImportarInmueblesDto,
  ): Promise<ResultadoImportacionInmuebles> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap (see
    // backend/CLAUDE.md's own note on this exact mistake).
    const copropiedad = await this.copropiedades.findById(copropiedadId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }

    const erroresCodigo: ResultadoImportacionInmuebles['errores'] = [];
    dto.filas.forEach((fila, indice) => {
      if (fila.codigoCopropiedad !== copropiedad.codigo) {
        erroresCodigo.push({
          fila: indice + 1,
          codigo: fila.codigo ?? null,
          mensaje: `El código de copropiedad "${fila.codigoCopropiedad}" no coincide con el de la copropiedad activa (${copropiedad.codigo})`,
        });
      }
    });
    if (erroresCodigo.length > 0) {
      return {
        total: dto.filas.length,
        creados: 0,
        actualizados: 0,
        errores: erroresCodigo,
        eliminadosAntes: 0,
        bloqueadosPorFactura: [],
      };
    }

    const errores: ResultadoImportacionInmuebles['errores'] = [];
    let creados = 0;
    let actualizados = 0;

    // Coarse progress signal for the frontend to poll while this request is
    // in flight — see ProgresoImportacionService's own note. Cleared in
    // `finally` so a thrown error never leaves a stuck row behind.
    const total = dto.filas.length;
    const intervalo = this.progreso.intervalo(total);
    await this.progreso.iniciar(copropiedadId, 'inmuebles', total);

    try {
      for (const [indice, fila] of dto.filas.entries()) {
        try {
          const resultado = await this.upsertFila(copropiedadId, fila);
          if (resultado === 'actualizado') actualizados += 1;
          else creados += 1;
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
            copropiedadId,
            'inmuebles',
            completadas,
            total,
          );
        }
      }
    } finally {
      await this.progreso.finalizar(copropiedadId, 'inmuebles');
    }

    return {
      total: dto.filas.length,
      creados,
      actualizados,
      errores,
      eliminadosAntes: 0,
      bloqueadosPorFactura: [],
    };
  }

  /**
   * One row of an import: patch the unit when its code exists in the active
   * coproperty, create it otherwise.
   *
   * The lookup is tenant-scoped (`copropiedadId` is part of the filter —
   * never a bare `findById`) and case/whitespace-insensitive, so
   * " torre a-301 " finds the stored "Torre A-301" instead of creating a
   * second unit. The write then targets the FOUND `_id` together with
   * `copropiedadId`, never the row's code.
   *
   * The titular is resolved BEFORE the unit is touched: `resolverTitular`
   * validates the DIAN/DANE codes (and the emails) first, so a bad row fails
   * with neither the party nor the unit written.
   */
  private async upsertFila(
    copropiedadId: Types.ObjectId,
    filaCruda: FilaImportarInmuebleDto,
  ): Promise<'actualizado' | 'creado'> {
    const fila = this.sinCeldasVacias(filaCruda);

    const existente = await this.inmuebles
      .findOne(this.filtroCodigoDuplicado(copropiedadId, fila.codigo))
      .select('_id titularId')
      .lean()
      .exec();

    if (!existente) {
      const titularId = await this.resolverTitular(copropiedadId, fila);

      // Defaults (`propietario`, not resident, `vigente`) apply only here:
      // they describe a unit that did not exist, never a patch.
      await this.inmuebles.create({
        copropiedadId,
        codigo: fila.codigo,
        referencia: fila.referencia,
        bloque: fila.bloque,
        zona: fila.zona,
        uso: fila.uso,
        area: fila.area,
        coeficiente: fila.coeficiente,
        titularId,
        tipoTitular: fila.tipoTitular ?? 'propietario',
        resideEnElInmueble: fila.resideEnElInmueble ?? false,
        estadoCartera: fila.estadoCartera ?? 'vigente',
        contacto: fila.contacto,
        observaciones: fila.observaciones,
      });
      return 'creado';
    }

    const titularId = await this.resolverTitular(copropiedadId, fila, {
      unidadId: existente._id,
      titularActualId: existente.titularId ?? null,
    });

    const cambios = this.aDocumento(fila);
    // Immutable / not carried by an import row: stripped even though the row
    // type cannot hold `estado` today, so a future column cannot leak in.
    delete cambios.codigo;
    delete cambios.estado;
    if (titularId) cambios.titularId = titularId;

    if (Object.keys(cambios).length > 0) {
      await this.inmuebles
        .updateOne({ _id: existente._id, copropiedadId }, { $set: cambios })
        .exec();
    }
    return 'actualizado';
  }

  /**
   * Drops the keys whose value is an empty or whitespace-only string, so a
   * blank cell reads as "not sent" everywhere downstream (unit patch, titular
   * resolution and creation alike). `codigo` and `codigoCopropiedad` are kept:
   * they are the row's identity and were validated as non-empty already.
   */
  private sinCeldasVacias(
    fila: FilaImportarInmuebleDto,
  ): FilaImportarInmuebleDto {
    const limpia: Record<string, unknown> = {};
    for (const [clave, valor] of Object.entries(fila)) {
      const vacia = typeof valor === 'string' && valor.trim() === '';
      if (!vacia || clave === 'codigo' || clave === 'codigoCopropiedad') {
        limpia[clave] = valor;
      }
    }
    return limpia as unknown as FilaImportarInmuebleDto;
  }

  /** Null while no import is currently running for the active coproperty —
   *  see `ProgresoImportacionService.obtener`. */
  async obtenerProgresoImportacion(): Promise<ProgresoActual | null> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    return this.progreso.obtener(copropiedadId, 'inmuebles');
  }

  /**
   * Decides which party answers for the row's unit: reuses one when it can
   * be identified, creates one when the row names somebody new, or leaves
   * the titular alone when the row carries nothing to identify or name
   * anyone — a building loaded before its ownership papers is the ordinary
   * case here, not an error.
   *
   * A reused party is also REFRESHED with whatever this row provides —
   * never left as-is — so a corrected file can fix a party's own data
   * (address, city, document type…) once it exists. Only fields the row sent
   * are written (blank cells were already dropped by `sinCeldasVacias`).
   *
   * Resolution order:
   * 1. The row carries `numeroIdentificacionTitular`: the party is the
   *    Tercero of this coproperty with that identification (refreshed). The
   *    unit is then pointed at it, which is also how a unit changes hands.
   * 2. No identification but the row names somebody, and `unidad` is an
   *    EXISTING unit with a titular: that unit's current Tercero is refreshed
   *    in place, but ONLY if no other unit of this coproperty points at it.
   *    A shared owner's name must never be overwritten because one of their
   *    units was sold — that would silently corrupt their other units.
   * 3. Otherwise (new unit, unit without titular, shared party, or a dangling
   *    reference) a NEW Tercero is created.
   * A row that names nobody and has no identification returns `undefined`:
   * the caller leaves `titularId` untouched.
   *
   * `personType` is inferred from which name columns the row filled in
   * (`razonSocialTitular` → jurídica, otherwise natural) — the template has
   * no separate "tipo de persona" column.
   *
   * `tipoIdentificacionTitular`/`ciudadTitular` are DIAN/DANE codes, the same
   * ones the manual Titular form's dropdowns write — validated against the
   * same static catalog (`CatalogosService`) rather than trusted as free
   * text, since a typo here would silently save a code no DIAN reader
   * recognizes. Validation runs before any write, so a bad code fails only
   * this row and leaves both the party and the unit untouched.
   */
  private async resolverTitular(
    copropiedadId: Types.ObjectId,
    fila: FilaImportarInmuebleDto,
    unidad?: {
      unidadId: Types.ObjectId;
      titularActualId: Types.ObjectId | null;
    },
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
          copropiedadId,
          numeroIdentificacion: fila.numeroIdentificacionTitular,
        })
        .exec();
      if (existente) {
        await this.actualizarTitularExistente(
          copropiedadId,
          existente,
          fila,
          ciudad,
          ciudadDepartamento,
        );
        return existente._id;
      }
    }

    if (!nombre) return undefined;

    if (unidad?.titularActualId) {
      const actual = await this.terceros
        .findOne({ _id: unidad.titularActualId, copropiedadId })
        .select('primerNombre segundoNombre primerApellido segundoApellido')
        .lean()
        .exec();
      if (actual) {
        const compartido = await this.inmuebles
          .exists({
            copropiedadId,
            titularId: unidad.titularActualId,
            _id: { $ne: unidad.unidadId },
          })
          .exec();
        if (!compartido) {
          await this.actualizarTitularExistente(
            copropiedadId,
            actual,
            fila,
            ciudad,
            ciudadDepartamento,
          );
          return actual._id;
        }
      }
    }

    const creado = await this.terceros.create({
      copropiedadId,
      tipoPersona: personType,
      nombre: nombre,
      primerNombre: fila.nom1Titular,
      segundoNombre: fila.nom2Titular,
      primerApellido: fila.ape1Titular,
      segundoApellido: fila.ape2Titular,
      razonSocial: fila.razonSocialTitular,
      tipoIdentificacion: fila.tipoIdentificacionTitular,
      numeroIdentificacion: fila.numeroIdentificacionTitular,
      digitoVerificacion: fila.digitoVerificacionTitular,
      emails: parseEmails(fila.emailTitular),
      telefono: fila.telefonoTitular,
      direccion: fila.direccionTitular,
      ciudad: ciudad,
      ciudadCodigo: fila.ciudadTitular,
      ciudadDepartamentoCodigo: ciudadDepartamento,
    });
    return creado._id;
  }

  /**
   * Merges a row's fields into an already-existing party — only the ones
   * this row actually sent, same "don't clear what wasn't touched" rule
   * `aDocumento` follows for the unit itself. The write is scoped by
   * `copropiedadId` as well as `_id`, so a stale or foreign id can never
   * patch another building's party.
   *
   * `nombre`/`tipoPersona` are only recomputed when the row actually carries
   * name data: a row that only repeats a known identification must not blank
   * out a name it never mentioned. When the row sends SOME of the split name
   * parts (say only `ape2Titular`), the missing ones come from the stored
   * party, so `nombre` stays consistent with the parts instead of being
   * rebuilt from a fragment ("Juan Pérez" over a stored "Juan Carlos Pérez
   * Gómez").
   */
  private async actualizarTitularExistente(
    copropiedadId: Types.ObjectId,
    existente: Pick<
      Tercero,
      'primerNombre' | 'segundoNombre' | 'primerApellido' | 'segundoApellido'
    > & { _id: Types.ObjectId },
    fila: FilaImportarInmuebleDto,
    ciudad: string | undefined,
    ciudadDepartamento: string | undefined,
  ): Promise<void> {
    const { personType, nombre } = this.nombreParaRefresco(fila, existente);
    const cambios: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) cambios[clave] = valor;
    };

    set('tipoPersona', personType);
    set('nombre', nombre);
    set('primerNombre', fila.nom1Titular);
    set('segundoNombre', fila.nom2Titular);
    set('primerApellido', fila.ape1Titular);
    set('segundoApellido', fila.ape2Titular);
    set('razonSocial', fila.razonSocialTitular);
    set('tipoIdentificacion', fila.tipoIdentificacionTitular);
    set('digitoVerificacion', fila.digitoVerificacionTitular);
    set(
      'emails',
      fila.emailTitular === undefined
        ? undefined
        : parseEmails(fila.emailTitular),
    );
    set('telefono', fila.telefonoTitular);
    set('direccion', fila.direccionTitular);
    set('ciudad', ciudad);
    set('ciudadCodigo', fila.ciudadTitular);
    set('ciudadDepartamentoCodigo', ciudadDepartamento);

    if (Object.keys(cambios).length === 0) return;
    await this.terceros
      .updateOne({ _id: existente._id, copropiedadId }, { $set: cambios })
      .exec();
  }

  /**
   * The `tipoPersona`/`nombre` a refresh should write, or `undefined` for
   * both when the row carries no name data at all (see
   * `actualizarTitularExistente`).
   */
  private nombreParaRefresco(
    fila: FilaImportarInmuebleDto,
    existente: Pick<
      Tercero,
      'primerNombre' | 'segundoNombre' | 'primerApellido' | 'segundoApellido'
    >,
  ): {
    personType: 'natural' | 'juridica' | undefined;
    nombre: string | undefined;
  } {
    const sinCambio = { personType: undefined, nombre: undefined };

    if (fila.razonSocialTitular) {
      const nombre = resolverNombreTercero({
        tipoPersona: 'juridica',
        nombre: fila.nombreTitular,
        razonSocial: fila.razonSocialTitular,
      });
      return nombre ? { personType: 'juridica', nombre } : sinCambio;
    }

    const traePartes = [
      fila.nom1Titular,
      fila.nom2Titular,
      fila.ape1Titular,
      fila.ape2Titular,
    ].some(Boolean);
    if (!traePartes && !fila.nombreTitular) return sinCambio;

    // Stored parts only fill the gaps when the row sent split parts; a row
    // that only carries the legacy single `nombreTitular` column keeps its
    // old meaning (that string IS the name).
    const nombre = resolverNombreTercero({
      tipoPersona: 'natural',
      nombre: fila.nombreTitular,
      nom1:
        fila.nom1Titular ??
        (traePartes ? existente.primerNombre : null) ??
        undefined,
      nom2:
        fila.nom2Titular ??
        (traePartes ? existente.segundoNombre : null) ??
        undefined,
      ape1:
        fila.ape1Titular ??
        (traePartes ? existente.primerApellido : null) ??
        undefined,
      ape2:
        fila.ape2Titular ??
        (traePartes ? existente.segundoApellido : null) ??
        undefined,
    });
    return nombre ? { personType: 'natural', nombre } : sinCambio;
  }

  /**
   * The filter behind every "does this code already exist" check — `create`
   * and `importar` use it, manual entry and bulk file alike, so a unit can
   * never be duplicated by one path when the other would have caught it
   * (`update` no longer needs it: the code is immutable).
   *
   * Case- and whitespace-insensitive on purpose: the unique index and the
   * schema's own `trim: true` only protect an EXACT string, so "301",
   * " 301" and "Torre A-301" vs "torre a-301" used to slip through as
   * distinct units. Anchored so "301" cannot match "3010".
   */
  private filtroCodigoDuplicado(
    copropiedadId: Types.ObjectId,
    codigo: string,
    excluirId?: string,
  ): Record<string, unknown> {
    return {
      copropiedadId,
      codigo: { $regex: `^${escapeRegex(codigo.trim())}$`, $options: 'i' },
      ...(excluirId ? { _id: { $ne: excluirId } } : {}),
    };
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

    set('codigo', dto.codigo);
    set('referencia', dto.referencia);
    set('bloque', dto.bloque);
    set('zona', dto.zona);
    set('uso', dto.uso);
    set('area', dto.area);
    set('coeficiente', dto.coeficiente);
    set('titularId', dto.titularId);
    set('tipoTitular', dto.tipoTitular);
    set('resideEnElInmueble', dto.resideEnElInmueble);
    set('estadoCartera', dto.estadoCartera);
    if (dto.estado !== undefined) {
      doc.estado = dto.estado === 'inactivo' ? 'inactive' : 'active';
    }
    set('contacto', dto.contacto);
    set('observaciones', dto.observaciones);

    return doc;
  }
}
