// src/modules/entidades/entidades.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EntidadAdministradora,
  EntidadAdministradoraDocument,
} from '../../database/schemas/entidades/entidad-administradora.schema';
import {
  ContadorEntidadAdministradora,
  ContadorEntidadAdministradoraDocument,
} from '../../database/schemas/entidades/contador-entidad-administradora.schema';
import type {
  EntidadAdministradora as EntidadContract,
  Paginado,
} from '../../contracts';
import { toEntidad } from './entidades.mapper';
import type { ListarEntidadesDto } from './dto/listar-entidades.dto';
import type {
  ActualizarEntidadDto,
  CrearEntidadDto,
} from './dto/guardar-entidad.dto';
import { escapeRegex } from '../../common/utils/query.utils';
import { AuditoriaService } from '../auditoria/auditoria.service';

/**
 * Manages the platform's catalogue of managing entities.
 *
 * Deliberately NOT scoped by TenantContextService: these records exist above
 * any single coproperty, so there is no active tenant to filter by. Access is
 * restricted at the controller by PlatformAdminGuard instead.
 */
@Injectable()
export class EntidadesService {
  constructor(
    @InjectModel(EntidadAdministradora.name)
    private readonly entidades: Model<EntidadAdministradoraDocument>,
    @InjectModel(ContadorEntidadAdministradora.name)
    private readonly contador: Model<ContadorEntidadAdministradoraDocument>,
    private readonly auditoria: AuditoriaService,
  ) {}

  async findAll(query: ListarEntidadesDto): Promise<Paginado<EntidadContract>> {
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
      this.entidades
        .find(filtro)
        .sort({ code: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.entidades.countDocuments(filtro).exec(),
    ]);

    return { items: documentos.map(toEntidad), total, pagina, porPagina };
  }

  /**
   * Read-only preview of the code the next `create()` would assign — for
   * the "Código" field on the create form, shown auto-populated instead of
   * typed by hand. A pure read: it never touches the counter, so opening
   * the form and never submitting never burns a number.
   */
  async previsualizarSiguienteCodigo(): Promise<string> {
    return String((await this.pisoActual()) + 1).padStart(4, '0');
  }

  async findOne(id: string): Promise<EntidadContract> {
    const documento = await this.entidades.findById(id).exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la entidad ${id}`);
    }
    return toEntidad(documento);
  }

  async create(
    dto: CrearEntidadDto,
    actor: { accountId: string; nombre: string },
  ): Promise<EntidadContract> {
    const code = await this.siguienteCodigo();
    const creada = await this.entidades.create({
      ...this.aDocumento(dto),
      code,
    });

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'crear',
      entidadTipo: 'entidad-administradora',
      entidadId: creada._id.toString(),
      entidadEtiqueta: creada.name,
    });

    return toEntidad(creada);
  }

  /**
   * Edits a managing entity. There is deliberately no delete: setting `estado`
   * to `inactivo` is how one is retired, and it must keep working after —
   * every coproperty it once administered still needs to resolve who did.
   */
  async update(
    id: string,
    dto: ActualizarEntidadDto,
    actor: { accountId: string; nombre: string },
  ): Promise<EntidadContract> {
    const actualizada = await this.entidades
      .findByIdAndUpdate(id, { $set: this.aDocumento(dto) }, { new: true })
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la entidad ${id}`);
    }

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'actualizar',
      entidadTipo: 'entidad-administradora',
      entidadId: actualizada._id.toString(),
      entidadEtiqueta: actualizada.name,
    });

    return toEntidad(actualizada);
  }

  /**
   * The highest numeric `code` already in use — either already recorded on
   * the counter, or typed by hand before this became automatic (or any
   * future direct insert). The floor `siguienteCodigo()` must never
   * increment from below, and `previsualizarSiguienteCodigo()`'s read-only
   * view of the same thing.
   */
  private async pisoActual(): Promise<number> {
    const [maximo] = await this.entidades
      .find({ code: /^\d+$/ })
      .sort({ code: -1 })
      .collation({ locale: 'en_US', numericOrdering: true })
      .limit(1)
      .exec();
    const pisoEntidades = maximo ? parseInt(maximo.code, 10) : 0;

    const contadorActual = await this.contador.findOne({}).exec();
    const pisoContador = contadorActual?.valor ?? 0;

    return Math.max(pisoEntidades, pisoContador);
  }

  /**
   * Atomically increments the single counter document and formats the
   * result as a zero-padded 4-digit code ("0001", "0002", ...). The
   * increment and the read happen in one `findOneAndUpdate`, so two
   * concurrent creates can never receive the same number.
   *
   * Floors the counter first — see `pisoActual()`. Cheap to repeat on every
   * call: once the counter has caught up, the floor is a no-op.
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

  /**
   * Translates the Spanish payload into the English document shape. Only keys
   * the caller actually sent are included — spreading the DTO whole would
   * write `undefined` over fields nobody meant to clear. `code` is never set
   * here — `create()` assigns it from `siguienteCodigo()`, and it is
   * immutable after that, so `ActualizarEntidadDto` never carries it either.
   */
  private aDocumento(
    dto: CrearEntidadDto | ActualizarEntidadDto,
  ): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('name', dto.nombre);
    set('taxId', dto.nit);
    set('taxIdVerificationDigit', dto.digitoVerificacion);
    set('email', dto.email);
    set('phone', dto.telefono);
    if ('estado' in dto && dto.estado !== undefined) {
      doc.status = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    return doc;
  }
}
