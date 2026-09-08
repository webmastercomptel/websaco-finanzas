// src/modules/copropiedades/copropiedades.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ContadorCopropiedad,
  ContadorCopropiedadDocument,
} from '../../database/schemas/copropiedades/contador-copropiedad.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import type {
  Copropiedad as CopropiedadContract,
  Paginado,
} from '../../contracts';
import { toCopropiedad } from './copropiedades.mapper';
import type { ListarCopropiedadesDto } from './dto/listar-copropiedades.dto';
import type {
  ActualizarCopropiedadDto,
  CrearCopropiedadDto,
} from './dto/guardar-copropiedad.dto';
import { escapeRegex } from '../../common/utils/query.utils';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { ConceptosService } from '../conceptos/conceptos.service';

/**
 * Manages the platform's catalogue of coproperties.
 *
 * Deliberately NOT scoped by TenantContextService. A coproperty IS the tenant
 * — this service manages the definition of every tenant there is, so there is
 * no single active one to filter by. Access is restricted at the controller
 * by PlatformAdminGuard instead.
 */
@Injectable()
export class CopropiedadesService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(ContadorCopropiedad.name)
    private readonly contador: Model<ContadorCopropiedadDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Account.name)
    private readonly accounts: Model<AccountDocument>,
    private readonly auditoria: AuditoriaService,
    private readonly conceptos: ConceptosService,
  ) {}

  async findAll(
    query: ListarCopropiedadesDto,
  ): Promise<Paginado<CopropiedadContract>> {
    const filtro: Record<string, unknown> = {};

    if (query.estado !== 'todos') {
      filtro.status = query.estado === 'inactivo' ? 'inactive' : 'active';
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      filtro.$or = [{ code: patron }, { name: patron }];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.copropiedades
        .find(filtro)
        .populate('managingEntityId', 'name')
        .sort({ code: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.copropiedades.countDocuments(filtro).exec(),
    ]);

    const usuariosPorCopropiedad = await this.usuariosAdministradores(
      documentos.filter((d) => !d.managingEntityId).map((d) => d._id),
    );

    return {
      items: documentos.map((d) =>
        toCopropiedad(d, usuariosPorCopropiedad.get(d._id.toString()) ?? null),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Read-only preview of the code the next `create()` would assign — for
   * the "Código" field on the create form, auto-populated instead of typed
   * by hand. A pure read: it never touches the counter, so opening the form
   * and never submitting never burns a number.
   */
  async previsualizarSiguienteCodigo(): Promise<string> {
    return String((await this.pisoActual()) + 1).padStart(4, '0');
  }

  /**
   * The highest numeric `code` already in use — either already recorded on
   * the counter, or typed by hand before this became automatic (or any
   * future direct insert).
   */
  private async pisoActual(): Promise<number> {
    const [maximo] = await this.copropiedades
      .find({ code: /^\d+$/ })
      .sort({ code: -1 })
      .collation({ locale: 'en_US', numericOrdering: true })
      .limit(1)
      .exec();
    const pisoCopropiedades = maximo ? parseInt(maximo.code, 10) : 0;

    const contadorActual = await this.contador.findOne({}).exec();
    const pisoContador = contadorActual?.valor ?? 0;

    return Math.max(pisoCopropiedades, pisoContador);
  }

  /**
   * Atomically increments the single counter document and formats the
   * result as a zero-padded 4-digit code ("0001", "0002", ...). Floors the
   * counter at `pisoActual()` first — cheap to repeat on every call: once
   * the counter has caught up, the floor is a no-op.
   */
  private async siguienteCodigo(): Promise<string> {
    const piso = await this.pisoActual();

    await this.contador
      .updateOne(
        { valor: { $lt: piso } },
        { $set: { valor: piso } },
        { upsert: true },
      )
      .exec();

    const contador = await this.contador
      .findOneAndUpdate({}, { $inc: { valor: 1 } }, { upsert: true, new: true })
      .exec();
    return String(contador.valor).padStart(4, '0');
  }

  async findOne(id: string): Promise<CopropiedadContract> {
    const documento = await this.copropiedades
      .findById(id)
      .populate('managingEntityId', 'name')
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la copropiedad ${id}`);
    }
    const usuariosPorCopropiedad = documento.managingEntityId
      ? new Map<string, string>()
      : await this.usuariosAdministradores([documento._id]);
    return toCopropiedad(
      documento,
      usuariosPorCopropiedad.get(documento._id.toString()) ?? null,
    );
  }

  /**
   * The account(s) with an active Asignación scoped directly to each given
   * coproperty — one batch query for the page, not one per row. Callers
   * only pass ids of buildings with no `managingEntityId`: an entidad grant
   * covers a building through the company, never through a per-building
   * Asignación row, so a managed building's "who has access" question is
   * already answered by `entidadAdministradora`.
   */
  private async usuariosAdministradores(
    coPropertyIds: Types.ObjectId[],
  ): Promise<Map<string, string>> {
    if (coPropertyIds.length === 0) return new Map();

    const asignaciones = await this.asignaciones
      .find({
        scope: 'copropiedad',
        coPropertyId: { $in: coPropertyIds },
        status: 'active',
      })
      .exec();
    if (asignaciones.length === 0) return new Map();

    const accountIds = [
      ...new Set(asignaciones.map((a) => a.accountId.toString())),
    ];
    const cuentas = await this.accounts
      .find({ _id: { $in: accountIds } })
      .exec();
    const nombrePorCuenta = new Map(
      cuentas.map((c) => [c._id.toString(), c.fullName]),
    );

    const nombresPorCopropiedad = new Map<string, string[]>();
    for (const asignacion of asignaciones) {
      const cop = asignacion.coPropertyId!.toString();
      const nombre = nombrePorCuenta.get(asignacion.accountId.toString());
      if (!nombre) continue;
      const lista = nombresPorCopropiedad.get(cop) ?? [];
      lista.push(nombre);
      nombresPorCopropiedad.set(cop, lista);
    }

    return new Map(
      [...nombresPorCopropiedad.entries()].map(([cop, nombres]) => [
        cop,
        nombres.join(', '),
      ]),
    );
  }

  async create(
    dto: CrearCopropiedadDto,
    actor: { accountId: string; nombre: string },
  ): Promise<CopropiedadContract> {
    const code = await this.siguienteCodigo();
    const creada = await this.copropiedades.create({
      ...this.aDocumento(dto),
      code,
    });

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'crear',
      entidadTipo: 'copropiedad',
      entidadId: creada._id.toString(),
      entidadEtiqueta: creada.name,
    });

    // Created in this order so their auto-assigned sortOrder lands 1, 2, 3 —
    // ConceptosService.create() numbers each one past whatever came before.
    const copropiedadId = creada._id.toString();
    const cargosSistema = [
      { nombre: 'Administración', tipo: 'administracion' as const },
      { nombre: 'Intereses por Mora', tipo: 'intereses' as const },
      { nombre: 'Multas', tipo: 'otro' as const },
    ];
    for (const cargo of cargosSistema) {
      await this.conceptos.create(copropiedadId, {
        nombre: cargo.nombre,
        tipo: cargo.tipo,
        sistema: true,
      });
    }

    // Re-read populated: the created document holds a raw id for the managing
    // entity, and the contract promises its name.
    return this.findOne(creada._id.toString());
  }

  /**
   * Edits a coproperty. There is deliberately no delete: `estado: 'inactivo'`
   * stops it being billed and keeps every invoice and receipt ever issued
   * against it readable, for the same reason nothing removes a financial
   * document.
   */
  async update(
    id: string,
    dto: ActualizarCopropiedadDto,
    actor: { accountId: string; nombre: string },
  ): Promise<CopropiedadContract> {
    const actualizada = await this.copropiedades
      .findByIdAndUpdate(id, { $set: this.aDocumento(dto) }, { new: true })
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la copropiedad ${id}`);
    }

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'actualizar',
      entidadTipo: 'copropiedad',
      entidadId: actualizada._id.toString(),
      entidadEtiqueta: actualizada.name,
    });

    return this.findOne(actualizada._id.toString());
  }

  /**
   * Translates the Spanish payload into the English document shape. Only keys
   * the caller actually sent are included — spreading the DTO whole would
   * write `undefined` over fields nobody meant to clear.
   *
   * A building has a managing company or it does not, never a partial state
   * of both, so setting one clears the other: naming a managing entity
   * retires the plain-text note, and setting that note detaches the building
   * from whatever company was on file. Neither field is who administers the
   * building day to day — that is always a real person, tracked in
   * Usuarios/Asignacion, present whether or not a company is on file here.
   */
  private aDocumento(
    dto: CrearCopropiedadDto | ActualizarCopropiedadDto,
  ): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('name', dto.nombre);
    set('taxId', dto.nit);
    set('taxIdVerificationDigit', dto.digitoVerificacion);
    set('address', dto.direccion);
    set('city', dto.ciudad);
    set('phone', dto.telefono);
    set('email', dto.email);
    set('usesBuildingManagement', dto.usaGestionEdificios);
    set('receivablesAccount', dto.cuentaContableCartera);
    set('advancesAccount', dto.cuentaAnticipos);
    set('creditNotesAccount', dto.cuentaDevoluciones);
    if ('estado' in dto && dto.estado !== undefined) {
      doc.status = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    if (dto.entidadAdministradoraId !== undefined) {
      doc.managingEntityId = dto.entidadAdministradoraId;
      doc.administratorName = null;
    } else if (dto.nombreAdministrador !== undefined) {
      doc.administratorName = dto.nombreAdministrador;
      doc.managingEntityId = null;
    }

    return doc;
  }
}
