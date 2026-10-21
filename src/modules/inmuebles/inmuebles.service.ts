// src/modules/inmuebles/inmuebles.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
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
  ExportacionImportacionInmuebles,
  Inmueble as InmuebleContract,
  Paginado,
  ResultadoImportacionInmuebles,
} from '../../contracts';
import { toFilaExportacion, toInmueble } from './inmuebles.mapper';
import type { ListarInmueblesDto } from './dto/listar-inmuebles.dto';
import type {
  ActualizarInmuebleDto,
  CrearInmuebleDto,
} from './dto/guardar-inmueble.dto';
import type {
  FilaImportarInmuebleDto,
  ImportarInmueblesDto,
} from './dto/importar-inmuebles.dto';

/**
 * Defensive ceiling for `exportarImportacion`, which is deliberately not
 * paginated (the file is one unit per row and a partial roster would be a
 * silently wrong spreadsheet). Far above any real building; past it the
 * request fails loudly instead of loading an unbounded set into memory.
 */
export const MAX_INMUEBLES_EXPORTACION = 5000;

/** A Tercero as the importer reads it back: just what name recomposition and
 *  the same-person comparison need. */
type TerceroLeido = Pick<
  Tercero,
  | 'nombre'
  | 'primerNombre'
  | 'segundoNombre'
  | 'primerApellido'
  | 'segundoApellido'
  | 'razonSocial'
  | 'numeroIdentificacion'
> & { _id: Types.ObjectId };

/** Values derived from a row's titular columns by `validarFila`. */
interface DatosTitularFila {
  ciudad?: string;
  ciudadDepartamento?: string;
  emails?: string[];
}

/** What an import row does about its titular — see `planificarTitular`. */
type PlanTitular =
  | { tipo: 'ninguno' }
  | {
      tipo: 'refrescar';
      tercero: TerceroLeido;
      /** Also write the row's identification onto that Tercero (filling in
       *  missing papers of the same person). */
      asignarIdentificacion?: boolean;
    }
  | { tipo: 'crear' };

/** Records created by the row being processed, so a failure later in the same
 *  row can take back exactly those — see `upsertFila`. */
interface RastroFila {
  terceroId?: Types.ObjectId;
}

/** Same person by display name: trim, spaces collapsed, case-insensitive. */
const mismoNombre = (a?: string | null, b?: string | null): boolean => {
  const normalizar = (v: string): string =>
    v.trim().replace(/s+/g, ' ').toLowerCase();
  return !!a && !!b && normalizar(a) === normalizar(b);
};

/** The name a stored Tercero's own parts compose (its `razonSocial` for a
 *  jurídica), which can differ from its stored `nombre` when that was typed
 *  by hand — see `planificarTitular`. */
const nombreDePartes = (t: TerceroLeido): string | null =>
  t.razonSocial?.trim() ||
  resolverNombreTercero({
    tipoPersona: 'natural',
    nom1: t.primerNombre ?? undefined,
    nom2: t.segundoNombre ?? undefined,
    ape1: t.primerApellido ?? undefined,
    ape2: t.segundoApellido ?? undefined,
  });

/**
 * Turns whatever a row threw into a message safe for the client. A Mongo
 * duplicate-key error (`E11000`) would otherwise leak the collection and
 * index names, and it can come from two unique indexes: the unit code and
 * the Tercero identification, so the message is chosen by which key clashed.
 */
const mensajeDeFila = (err: unknown): string => {
  const e = err as {
    code?: number;
    keyPattern?: Record<string, unknown>;
    message?: string;
  } | null;
  if (e?.code === 11000) {
    const porIdentificacion =
      (e.keyPattern && 'numeroIdentificacion' in e.keyPattern) ||
      (!e.keyPattern && e.message?.includes('numeroIdentificacion'));
    return porIdentificacion
      ? 'Identificación duplicada: ya existe un titular con esa identificación en esta copropiedad'
      : 'Código duplicado: ya existe un inmueble con ese código en esta copropiedad';
  }
  return err instanceof Error ? err.message : 'Error desconocido';
};

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
   * - The titular follows `planificarTitular`: an identification that matches
   *   a Tercero refreshes and assigns it; an identification that matches none
   *   always creates a new one (never touches the unit's current owner); with
   *   no identification the unit's own Tercero is refreshed when the name is
   *   the same person's or the party is not shared, and a new one is created
   *   otherwise. An identification with nobody to match and no name to create
   *   from is a row error.
   * - DIAN/DANE codes and emails are validated before anything of that row is
   *   written. A row is best-effort atomic (see `upsertFila`): a Tercero it
   *   created is taken back if the unit then fails, but an existing unit's
   *   patch is NOT rolled back when the titular step fails — no Mongo
   *   transactions here.
   * - A duplicate-key error is reported as "Código duplicado", never with
   *   index names.
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
            mensaje: mensajeDeFila(err),
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
   * second unit. Writes then target the FOUND `_id` together with
   * `copropiedadId`, never the row's code.
   *
   * Everything that can fail without writing — DIAN/DANE codes, emails, an
   * identification that points at no party and has no name to create one
   * (`validarFila`, `planificarTitular`) — is decided BEFORE the first write
   * of the row, so a rejected row leaves the unit and the party untouched.
   *
   * Atomicity is per row but best-effort, because this codebase has no Mongo
   * transactions:
   * - NEW unit: the party (if any) is written first because the unit needs
   *   its id. If creating the unit then fails, the Tercero THIS row just
   *   created is deleted (tenant-scoped, by id), so a failing row — and each
   *   retry of it — never leaves an orphan party behind. Refreshing a party
   *   that already existed is not undone: it is an idempotent correction.
   * - EXISTING unit: the unit patch goes first, then the titular step and the
   *   `titularId` repoint. If the titular step fails, the Tercero created by
   *   it is deleted, but the unit patch stays — updates are NOT transactional
   *   per row, and the row is reported as an error (not counted as updated).
   * These deletes only ever take back records created moments earlier by the
   * same row; nothing pre-existing is ever deleted by an import.
   */
  private async upsertFila(
    copropiedadId: Types.ObjectId,
    filaCruda: FilaImportarInmuebleDto,
  ): Promise<'actualizado' | 'creado'> {
    const fila = this.sinCeldasVacias(filaCruda);
    const datos = this.validarFila(fila);

    const existente = await this.inmuebles
      .findOne(this.filtroCodigoDuplicado(copropiedadId, fila.codigo))
      .select('_id titularId')
      .lean()
      .exec();

    const plan = await this.planificarTitular(
      copropiedadId,
      fila,
      existente
        ? {
            unidadId: existente._id,
            titularActualId: existente.titularId ?? null,
          }
        : undefined,
    );
    const rastro: RastroFila = {};

    try {
      if (!existente) {
        const titularId = await this.aplicarTitular(
          copropiedadId,
          fila,
          datos,
          plan,
          rastro,
        );

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

      const cambios = this.aDocumento(fila);
      // Immutable / not carried by an import row: stripped even though the
      // row type cannot hold `estado` today, so a future column cannot leak
      // in.
      delete cambios.codigo;
      delete cambios.estado;
      delete cambios.titularId;
      if (Object.keys(cambios).length > 0) {
        await this.inmuebles
          .updateOne({ _id: existente._id, copropiedadId }, { $set: cambios })
          .exec();
      }

      const titularId = await this.aplicarTitular(
        copropiedadId,
        fila,
        datos,
        plan,
        rastro,
      );
      // Repoint only when it actually changes: an unedited re-import must not
      // write anything for a titular that is already the right one.
      if (
        titularId &&
        titularId.toString() !== existente.titularId?.toString()
      ) {
        await this.inmuebles
          .updateOne(
            { _id: existente._id, copropiedadId },
            { $set: { titularId } },
          )
          .exec();
      }
      return 'actualizado';
    } catch (err) {
      if (rastro.terceroId) {
        // The repoint may have been applied before the error surfaced: a
        // Tercero a unit already points at must not be deleted (an orphan
        // party is harmless, a dangling `titularId` is not). If even that
        // check fails, keep the Tercero.
        const referenciado = await this.inmuebles
          .exists({ copropiedadId, titularId: rastro.terceroId })
          .exec()
          .catch(() => true);
        if (!referenciado) {
          await this.terceros
            .deleteOne({ _id: rastro.terceroId, copropiedadId })
            .exec()
            .catch(() => undefined);
        }
      }
      throw err;
    }
  }

  /**
   * Drops the keys whose value is `null`, `undefined` or an empty /
   * whitespace-only string, so a blank cell (or a JSON `null`, which is what
   * some clients send for "no value") reads as "not sent" everywhere
   * downstream: unit patch, titular resolution and creation alike. `codigo`
   * and `codigoCopropiedad` are kept: they are the row's identity and were
   * validated as non-empty already.
   */
  private sinCeldasVacias(
    fila: FilaImportarInmuebleDto,
  ): FilaImportarInmuebleDto {
    const limpia: Record<string, unknown> = {};
    for (const [clave, valor] of Object.entries(fila)) {
      const ausente =
        valor === null ||
        valor === undefined ||
        (typeof valor === 'string' && valor.trim() === '');
      if (!ausente || clave === 'codigo' || clave === 'codigoCopropiedad') {
        limpia[clave] = valor;
      }
    }
    return limpia as unknown as FilaImportarInmuebleDto;
  }

  /**
   * The roster in the import's own shape: every unit of the active
   * coproperty (active AND inactive) with its titular's columns, so a person
   * can download it, correct cells and upload it back through `importar` —
   * which only patches what changed and never deletes.
   *
   * Tenant-scoped on both queries: the units by `copropiedadId`, and the
   * titulares by `copropiedadId` AND the ids the units pointed at — never a
   * bare `_id` lookup, so a stale or foreign `titularId` can't leak another
   * building's party into this file. Both reads are `lean` with a minimal
   * `select`: this returns personal data of every owner, so it carries no
   * more columns than the file has.
   *
   * Not paginated by design (see `MAX_INMUEBLES_EXPORTACION`). Fetching one
   * row past the ceiling is enough to know it was exceeded.
   *
   * Known limitation: `estado` is not exported because the import cannot
   * carry it. That is the safe direction — an inactive unit stays inactive
   * when its exported row is loaded back, since update never touches it.
   */
  async exportarImportacion(): Promise<ExportacionImportacionInmuebles> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap.
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('codigo')
      .lean()
      .exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }

    const unidades = await this.inmuebles
      .find({ copropiedadId })
      .select(
        'codigo referencia bloque zona uso area coeficiente titularId tipoTitular resideEnElInmueble estadoCartera contacto observaciones',
      )
      .sort({ codigo: 1 })
      .limit(MAX_INMUEBLES_EXPORTACION + 1)
      .lean()
      .exec();
    if (unidades.length > MAX_INMUEBLES_EXPORTACION) {
      throw new UnprocessableEntityException(
        `La copropiedad tiene más de ${MAX_INMUEBLES_EXPORTACION} inmuebles: la exportación no admite más de ese número.`,
      );
    }

    const titularIds = [
      ...new Set(
        unidades
          .map((u) => u.titularId?.toString())
          .filter((id): id is string => Boolean(id)),
      ),
    ].map((id) => new Types.ObjectId(id));
    const titulares = titularIds.length
      ? await this.terceros
          .find({ copropiedadId, _id: { $in: titularIds } })
          .select(
            'primerNombre segundoNombre primerApellido segundoApellido razonSocial tipoIdentificacion numeroIdentificacion digitoVerificacion emails telefono direccion ciudadCodigo',
          )
          .lean()
          .exec()
      : [];
    const titularPorId = new Map(titulares.map((t) => [t._id.toString(), t]));

    return {
      copropiedadCodigo: copropiedad.codigo,
      filas: unidades.map((u) =>
        toFilaExportacion(
          copropiedad.codigo,
          u,
          u.titularId ? titularPorId.get(u.titularId.toString()) : undefined,
        ),
      ),
    };
  }

  /** Null while no import is currently running for the active coproperty —
   *  see `ProgresoImportacionService.obtener`. */
  async obtenerProgresoImportacion(): Promise<ProgresoActual | null> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    return this.progreso.obtener(copropiedadId, 'inmuebles');
  }

  /**
   * Everything about a row that can be rejected WITHOUT touching the
   * database: the DIAN and DANE codes are checked against the static catalog
   * (`CatalogosService`) rather than trusted as free text — a typo would
   * silently save a code no DIAN reader recognizes — and the email cell is
   * parsed. Run before the first write of the row, so a bad row leaves the
   * unit AND the party exactly as they were. Returns the derived values the
   * writers need, so nothing is parsed twice.
   */
  private validarFila(fila: FilaImportarInmuebleDto): DatosTitularFila {
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

    return {
      ciudad,
      ciudadDepartamento,
      emails:
        fila.emailTitular === undefined
          ? undefined
          : parseEmails(fila.emailTitular),
    };
  }

  /**
   * Decides, with READS only, which party answers for the row's unit — the
   * caller applies the decision with `aplicarTitular`, so every way a row can
   * be rejected is known before its first write.
   *
   * - `ninguno`: the row carries nothing to identify or name anyone (a
   *   building loaded before its ownership papers is the ordinary case, not
   *   an error); the unit's `titularId` is left untouched.
   * - `refrescar`: an existing Tercero of this coproperty is updated with the
   *   fields the row sent and the unit is pointed at it.
   * - `crear`: a NEW Tercero is created from the row.
   *
   * "Same person" below means the row's composed name equals (trim,
   * case-insensitive, spaces collapsed) EITHER the stored `nombre` OR the
   * composition of the stored name parts — a stored `nombre` that was typed
   * by hand and no longer matches its own parts must not make an unedited
   * export look like a different person.
   *
   * Resolution order:
   * 1. The row carries `numeroIdentificacionTitular`: the party is the
   *    Tercero of this coproperty with that identification — refreshed, and
   *    it is also how a unit changes hands. If NO Tercero has it:
   *    - the unit's current Tercero has NO identification yet and is the same
   *      person: it is refreshed in place AND receives that identification
   *      (filling in missing papers must not duplicate the owner). Safe
   *      because the lookup just proved no other Tercero of the coproperty
   *      has it, and the unique index only covers string values;
   *    - otherwise a new Tercero is created, ALWAYS — never a rename of the
   *      unit's current titular: the identification says "this is somebody
   *      else", and renaming the old owner's Tercero would give a person who
   *      still exists another person's name while keeping the old papers.
   *    A row that names nobody there is a row error: the identification points
   *    at nothing and there is no name to create it from.
   * 2. No identification, but the row names somebody (see `nombreDeFila`):
   *    - a new unit, a unit without titular or a dangling reference creates
   *      a new Tercero;
   *    - the same person is refreshed in place even when shared, which is
   *      what makes re-importing an unedited export a no-op for titulares;
   *    - a DIFFERENT name on a Tercero that HAS an identification is a
   *      different person without papers (a sale with the identification cell
   *      left empty): a new Tercero, regardless of sharing;
   *    - a different name on a name-only Tercero (no identification) is a typo
   *      fix or a renamed owner: refreshed in place only if no OTHER unit of
   *      this coproperty points at it; if one does, a new Tercero is created,
   *      because overwriting a shared owner's name for one unit would
   *      silently corrupt their other units.
   * 3. Neither identification nor name: `ninguno`.
   *
   * Known limitation: the "shared?" check reads the database, not the file.
   * If the rows of ALL the units sharing one Tercero get the same NEW name
   * without identification, the first rows each create a new Tercero while
   * the Tercero is still shared, and the last row finds it unshared and
   * renames it in place — the outcome depends on row order. Deferred: an
   * in-file name-to-id reuse map (see the `importar-inmuebles-upsert`
   * proposal).
   */
  private async planificarTitular(
    copropiedadId: Types.ObjectId,
    fila: FilaImportarInmuebleDto,
    unidad?: {
      unidadId: Types.ObjectId;
      titularActualId: Types.ObjectId | null;
    },
  ): Promise<PlanTitular> {
    const { nombre } = this.nombreDeFila(fila);

    const cargarActual = async (): Promise<TerceroLeido | null> =>
      unidad?.titularActualId
        ? await this.terceros
            .findOne({ _id: unidad.titularActualId, copropiedadId })
            .select(
              'nombre primerNombre segundoNombre primerApellido segundoApellido razonSocial numeroIdentificacion',
            )
            .lean()
            .exec()
        : null;
    const esMismaPersona = (actual: TerceroLeido): boolean => {
      const nombreFila =
        this.datosNombreRefresco(fila, actual).nombre ?? nombre;
      return (
        mismoNombre(nombreFila, actual.nombre) ||
        mismoNombre(nombreFila, nombreDePartes(actual))
      );
    };

    if (fila.numeroIdentificacionTitular) {
      const porIdentificacion = await this.terceros
        .findOne({
          copropiedadId,
          numeroIdentificacion: fila.numeroIdentificacionTitular,
        })
        .exec();
      if (porIdentificacion) {
        return { tipo: 'refrescar', tercero: porIdentificacion };
      }
      if (!nombre) {
        throw new Error(
          `El titular con identificación ${fila.numeroIdentificacionTitular} no existe y la fila no trae nombre para crearlo`,
        );
      }
      const actual = await cargarActual();
      if (actual && !actual.numeroIdentificacion && esMismaPersona(actual)) {
        return {
          tipo: 'refrescar',
          tercero: actual,
          asignarIdentificacion: true,
        };
      }
      return { tipo: 'crear' };
    }

    if (!nombre) return { tipo: 'ninguno' };
    const actual = await cargarActual();
    if (!actual || !unidad) return { tipo: 'crear' };

    if (esMismaPersona(actual)) return { tipo: 'refrescar', tercero: actual };
    if (actual.numeroIdentificacion) return { tipo: 'crear' };

    const compartido = await this.inmuebles
      .exists({
        copropiedadId,
        titularId: actual._id,
        _id: { $ne: unidad.unidadId },
      })
      .exec();
    return compartido
      ? { tipo: 'crear' }
      : { tipo: 'refrescar', tercero: actual };
  }

  /**
   * Carries out a `planificarTitular` decision and returns the Tercero the
   * unit must point at (`undefined` leaves `titularId` alone). When it
   * CREATES a Tercero the id is recorded in `rastro`, so the caller can take
   * back exactly that record if a later step of the same row fails.
   */
  private async aplicarTitular(
    copropiedadId: Types.ObjectId,
    fila: FilaImportarInmuebleDto,
    datos: DatosTitularFila,
    plan: PlanTitular,
    rastro: RastroFila,
  ): Promise<Types.ObjectId | undefined> {
    if (plan.tipo === 'ninguno') return undefined;

    if (plan.tipo === 'refrescar') {
      await this.actualizarTitularExistente(
        copropiedadId,
        plan.tercero,
        fila,
        datos,
        plan.asignarIdentificacion
          ? fila.numeroIdentificacionTitular
          : undefined,
      );
      return plan.tercero._id;
    }

    const { personType, nombre } = this.nombreDeFila(fila);
    const creado = await this.terceros.create({
      copropiedadId,
      tipoPersona: personType,
      nombre: nombre ?? undefined,
      primerNombre: fila.nom1Titular,
      segundoNombre: fila.nom2Titular,
      primerApellido: fila.ape1Titular,
      segundoApellido: fila.ape2Titular,
      razonSocial: fila.razonSocialTitular,
      tipoIdentificacion: fila.tipoIdentificacionTitular,
      numeroIdentificacion: fila.numeroIdentificacionTitular,
      digitoVerificacion: fila.digitoVerificacionTitular,
      emails: datos.emails ?? [],
      telefono: fila.telefonoTitular,
      direccion: fila.direccionTitular,
      ciudad: datos.ciudad,
      ciudadCodigo: fila.ciudadTitular,
      ciudadDepartamentoCodigo: datos.ciudadDepartamento,
    });
    rastro.terceroId = creado._id;
    return creado._id;
  }

  /**
   * The person type and display name a row describes on its OWN, ignoring
   * what is stored: `razonSocialTitular` → jurídica, otherwise natural (the
   * template has no separate "tipo de persona" column). `nombre` is null when
   * the row names nobody — which is also what gates whether a row may create
   * or replace a titular at all.
   */
  private nombreDeFila(fila: FilaImportarInmuebleDto): {
    personType: 'natural' | 'juridica';
    nombre: string | null;
  } {
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
    return { personType, nombre };
  }

  /**
   * Merges a row's fields into an already-existing party — only the ones
   * this row actually sent, same "don't clear what wasn't touched" rule
   * `aDocumento` follows for the unit itself. The write is scoped by
   * `copropiedadId` as well as `_id`, so a stale or foreign id can never
   * patch another building's party. The name columns are the delicate part
   * and live in `datosNombreRefresco`.
   */
  private async actualizarTitularExistente(
    copropiedadId: Types.ObjectId,
    existente: TerceroLeido,
    fila: FilaImportarInmuebleDto,
    datos: DatosTitularFila,
    numeroIdentificacion?: string,
  ): Promise<void> {
    const cambios: Record<string, unknown> = {
      ...this.datosNombreRefresco(fila, existente).cambios,
    };
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) cambios[clave] = valor;
    };

    set('numeroIdentificacion', numeroIdentificacion);
    set('tipoIdentificacion', fila.tipoIdentificacionTitular);
    set('digitoVerificacion', fila.digitoVerificacionTitular);
    set('emails', datos.emails);
    set('telefono', fila.telefonoTitular);
    set('direccion', fila.direccionTitular);
    set('ciudad', datos.ciudad);
    set('ciudadCodigo', fila.ciudadTitular);
    set('ciudadDepartamentoCodigo', datos.ciudadDepartamento);

    if (Object.keys(cambios).length === 0) return;
    await this.terceros
      .updateOne({ _id: existente._id, copropiedadId }, { $set: cambios })
      .exec();
  }

  /**
   * The name-related fields a refresh may write, plus the `nombre` they add
   * up to. Empty when the row carries no usable name data: a row that only
   * repeats a known identification must not blank out a name it never
   * mentioned.
   *
   * Name PARTS are written only together with a recomputed `nombre`, and the
   * recomputation fills what the row left out from the stored party — so a
   * row sending only `ape2Titular` never rebuilds "Juan Pérez" over a stored
   * "Juan Carlos Pérez Gómez", and a stored party with no parts to fill from
   * (nothing to compose a name with) is left alone entirely.
   *
   * When the row switches the person type the OPPOSITE set is cleared
   * (`razonSocial` vs the four parts), so a party is never half natural,
   * half jurídica: `razonSocialTitular` makes it jurídica and nulls the
   * parts; name parts make it natural and null `razonSocial`; the legacy
   * single `nombreTitular` column redefines the whole name, so it nulls the
   * parts and `razonSocial` too — unless it already equals the stored name,
   * in which case it is the same person and nothing is touched.
   */
  private datosNombreRefresco(
    fila: FilaImportarInmuebleDto,
    existente: Pick<
      TerceroLeido,
      | 'nombre'
      | 'primerNombre'
      | 'segundoNombre'
      | 'primerApellido'
      | 'segundoApellido'
    >,
  ): { cambios: Record<string, unknown>; nombre?: string } {
    const sinCambio = { cambios: {} };

    if (fila.razonSocialTitular) {
      const nombre = resolverNombreTercero({
        tipoPersona: 'juridica',
        nombre: fila.nombreTitular,
        razonSocial: fila.razonSocialTitular,
      });
      if (!nombre) return sinCambio;
      return {
        nombre,
        cambios: {
          tipoPersona: 'juridica',
          nombre,
          razonSocial: fila.razonSocialTitular,
          primerNombre: null,
          segundoNombre: null,
          primerApellido: null,
          segundoApellido: null,
        },
      };
    }

    const traePartes = [
      fila.nom1Titular,
      fila.nom2Titular,
      fila.ape1Titular,
      fila.ape2Titular,
    ].some(Boolean);

    if (!traePartes) {
      if (!fila.nombreTitular) return sinCambio;
      const nombre = resolverNombreTercero({
        tipoPersona: 'natural',
        nombre: fila.nombreTitular,
      });
      if (!nombre || mismoNombre(nombre, existente.nombre)) {
        return nombre ? { nombre, cambios: {} } : sinCambio;
      }
      return {
        nombre,
        cambios: {
          tipoPersona: 'natural',
          nombre,
          razonSocial: null,
          primerNombre: null,
          segundoNombre: null,
          primerApellido: null,
          segundoApellido: null,
        },
      };
    }

    const nombre = resolverNombreTercero({
      tipoPersona: 'natural',
      nombre: fila.nombreTitular,
      nom1: fila.nom1Titular ?? existente.primerNombre ?? undefined,
      nom2: fila.nom2Titular ?? existente.segundoNombre ?? undefined,
      ape1: fila.ape1Titular ?? existente.primerApellido ?? undefined,
      ape2: fila.ape2Titular ?? existente.segundoApellido ?? undefined,
    });
    if (!nombre) return sinCambio;

    const cambios: Record<string, unknown> = {
      tipoPersona: 'natural',
      nombre,
      razonSocial: null,
    };
    if (fila.nom1Titular !== undefined) cambios.primerNombre = fila.nom1Titular;
    if (fila.nom2Titular !== undefined) {
      cambios.segundoNombre = fila.nom2Titular;
    }
    if (fila.ape1Titular !== undefined) {
      cambios.primerApellido = fila.ape1Titular;
    }
    if (fila.ape2Titular !== undefined) {
      cambios.segundoApellido = fila.ape2Titular;
    }
    return { nombre, cambios };
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
