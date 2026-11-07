// src/modules/tareas/tareas.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Tarea,
  type EstadoTarea,
  type TareaDocument,
} from '../../database/schemas/administracion/tarea.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import type { Tarea as TareaContrato, TareaAsignable } from '../../contracts';
import { iniciales } from '../../common/utils/mapper.utils';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import type { ActualizarTareaDto } from './dto/actualizar-tarea.dto';
import type { CrearTareaDto } from './dto/guardar-tarea.dto';
import type { ListarTareasDto } from './dto/listar-tareas.dto';
import { construirCorreoTareaAsignada } from './tarea-correo';
import { desdeActualizarDto, desdeCrearDto, toTarea } from './tareas.mapper';

/** One audit line as it is written (the actor's name is frozen into it). */
interface EntradaHistorial {
  accion: string;
  usuario: string;
  fecha: Date;
}

/** Progress implied by moving a task to a column; the board has no other source for it. */
const PROGRESO_POR_ESTADO: Record<EstadoTarea, number> = {
  completado: 100,
  en_progreso: 50,
  pendiente: 0,
};

/**
 * Tasks of the ACTIVE coproperty. The tenant always comes from the request
 * context; every lookup and write filters by id AND `copropiedadId`, so a task
 * id of another building is a plain 404.
 *
 * Authorization is split in two layers on purpose. The controller decides what
 * a role may attempt (`manage` to create/edit/delete, `update` to complete or
 * comment, `read` to list); this service then narrows `update` and `read` to
 * "tasks assigned to me" unless the caller is a manager.
 */
@Injectable()
export class TareasService {
  private readonly logger = new Logger(TareasService.name);

  constructor(
    @InjectModel(Tarea.name)
    private readonly tareas: Model<TareaDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /**
   * Who a task notice may reach: a known, active account of this coproperty
   * that works in the back office. A resident-only account has no tasks
   * screen, so neither an email nor an in-app entry would lead anywhere.
   */
  private async destinatarioDePersonal(
    accountId: string,
    copropiedadId: Types.ObjectId,
  ): Promise<Destinatario | null> {
    const destinatario = await this.directorio.destinatarioDe(
      accountId,
      copropiedadId,
      'Tarea',
    );
    return destinatario?.perfil === 'personal' ? destinatario : null;
  }

  /**
   * Best-effort: emails and notifies the newly-assigned account that a task
   * landed on their plate. Never throws: a delivery failure is logged, not
   * surfaced, since the assignment itself already happened. A null access link
   * (the person holds a financial permission and must sign in normally) still
   * sends the email, just without the button.
   */
  private async notificarAsignacion(
    tarea: TareaDocument,
    copropiedadId: Types.ObjectId,
    accountId: string,
  ): Promise<void> {
    try {
      const destinatario = await this.destinatarioDePersonal(
        accountId,
        copropiedadId,
      );
      if (!destinatario) return;

      // `findById` is allowed here: the id IS the tenant.
      const copropiedad = await this.copropiedades
        .findById(copropiedadId)
        .select('nombre')
        .exec();
      const enlace = await this.enlaces.construir(
        destinatario.accountId,
        copropiedadId.toString(),
        `/tareas?abrir=${tarea._id.toString()}`,
      );
      const { asunto, html } = construirCorreoTareaAsignada({
        nombreAsignado: destinatario.nombre,
        nombreCopropiedad: copropiedad?.nombre ?? '',
        titulo: tarea.titulo,
        categoria: tarea.categoria,
        prioridad: tarea.prioridad,
        descripcion: tarea.descripcion || undefined,
        fechaLimite: tarea.fechaLimite,
        enlace,
      });

      const enviado = await this.correo.enviar({
        para: destinatario.email,
        asunto,
        html,
      });
      if (!enviado) {
        this.logger.error(
          `No se pudo notificar la asignación de la tarea ${tarea._id.toString()} a ${destinatario.email}.`,
        );
      }
      await this.notificaciones.crear({
        copropiedadId,
        accountId: destinatario.accountId,
        tipo: 'tarea',
        titulo: asunto,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la asignación de la tarea ${tarea._id.toString()}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Best-effort, in-app-only notice that an account was removed from a task's
   * assignee list. No email: losing a task isn't actionable the way a new
   * assignment is.
   */
  private async notificarDesasignacion(
    tarea: TareaDocument,
    copropiedadId: Types.ObjectId,
    accountId: string,
  ): Promise<void> {
    try {
      const destinatario = await this.destinatarioDePersonal(
        accountId,
        copropiedadId,
      );
      if (!destinatario) return;
      await this.notificaciones.crear({
        copropiedadId,
        accountId: destinatario.accountId,
        tipo: 'tarea',
        titulo: `Te quitaron de la tarea "${tarea.titulo}"`,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la desasignación de la tarea ${tarea._id.toString()}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Re-reads a task WITH its assignees populated, for the response. Scoped by
   * tenant like every other lookup (never `findById`), and only the name is
   * pulled from each account: the card needs nothing else.
   */
  private async cargarPoblada(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
  ): Promise<TareaDocument | null> {
    return this.tareas
      .findOne({ _id: id, copropiedadId })
      .populate({ path: 'asignadosIds', select: 'nombreCompleto' })
      .exec();
  }

  /**
   * Every assignee must be back-office staff of THIS coproperty who can read
   * tasks (same resolution as the notices). Without it a task manager could
   * store any account id and read that person's name back through the
   * populated card. Unknown, inactive, foreign or resident-only = 400.
   */
  private async exigirAsignablesValidos(
    ids: readonly string[],
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    for (const id of new Set(ids)) {
      const valido =
        Types.ObjectId.isValid(id) &&
        (await this.destinatarioDePersonal(id, copropiedadId)) !== null;
      if (!valido) {
        throw new BadRequestException(
          'Solo se puede asignar personal de esta copropiedad',
        );
      }
    }
  }

  /**
   * The active coproperty's staff who can read tasks, i.e. exactly who
   * `exigirAsignablesValidos` accepts as an assignee (the directory resolves
   * both). Only id and name leave: the form needs nothing else. A platform
   * administrator with no assignment here is accepted on write but not listed:
   * the directory enumerates assignments.
   */
  async asignables(): Promise<TareaAsignable[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const personal = await this.directorio.personalQuePuedeLeer(
      copropiedadId,
      'Tarea',
    );
    return personal
      .map((p) => ({
        accountId: p.accountId,
        nombre: p.nombre,
        iniciales: iniciales(p.nombre),
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Tarea ${id} no encontrada`);
    }
  }

  /** Creates a task in the active coproperty and returns the contract. */
  async crear(dto: CrearTareaDto, user: IRequestUser): Promise<TareaContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const actor = user.nombre || 'Usuario';

    const historial: EntradaHistorial[] = [
      { accion: 'Creó la tarea', usuario: actor, fecha: new Date() },
    ];
    const asignadosIds = dto.asignadosIds ?? [];
    await this.exigirAsignablesValidos(asignadosIds, copropiedadId);
    if (asignadosIds.length > 0) {
      historial.push({
        accion: 'Asignó la tarea inicialmente',
        usuario: actor,
        fecha: new Date(),
      });
    }

    const creada = await new this.tareas({
      ...desdeCrearDto(dto, copropiedadId),
      historial,
    }).save();

    for (const accountId of asignadosIds) {
      if (accountId !== user.accountId) {
        await this.notificarAsignacion(creada, copropiedadId, accountId);
      }
    }

    const poblada = await this.cargarPoblada(creada._id, copropiedadId);
    return toTarea(poblada ?? creada);
  }

  /**
   * Lists the active coproperty's tasks, optionally filtered by column
   * (`todos` = no filter), in board order. Anyone who is not a manager only
   * sees the tasks they are an assignee of.
   */
  async listar(
    filtros: ListarTareasDto,
    user: IRequestUser,
  ): Promise<TareaContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };

    if (!this.canManage(user)) {
      // Fail closed: "not a manager" must never degrade into "sees everything"
      // just because the caller has no usable account id.
      if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
        return [];
      }
      // An equality filter on an array field means "the array contains this".
      filtro.asignadosIds = new Types.ObjectId(user.accountId);
    }

    if (filtros.estado && filtros.estado !== 'todos') {
      filtro.estado = filtros.estado;
    }

    const documentos = await this.tareas
      .find(filtro)
      .populate({ path: 'asignadosIds', select: 'nombreCompleto' })
      .sort({ orden: 1 })
      .exec();
    return documentos.map(toTarea);
  }

  /** Edits a task (or moves it on the board) and returns the contract. */
  async actualizar(
    id: string,
    dto: ActualizarTareaDto,
    user: IRequestUser,
  ): Promise<TareaContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const existente = await this.tareas
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!existente) throw new NotFoundException(`Tarea ${id} no encontrada`);

    const cambios = desdeActualizarDto(dto);
    const ahora = new Date();
    const actor = user.nombre || 'Usuario';

    // Newly-generated audit entries only, never the full existing array.
    // Appended via $push below so this write can't clobber an entry landed
    // concurrently by completar()/agregarObservacion().
    const nuevasEntradas: EntradaHistorial[] = [];

    // 1. Intelligent progress: a column implies a progress value.
    if (dto.estado && dto.estado !== existente.estado) {
      nuevasEntradas.push({
        accion: `Movió la tarea a ${dto.estado}`,
        usuario: actor,
        fecha: ahora,
      });
      cambios.progreso = PROGRESO_POR_ESTADO[dto.estado];
    }

    // 2. Audit history: assignment changes (a set diff, several assignees).
    let agregados: string[] = [];
    let removidos: string[] = [];
    if (dto.asignadosIds !== undefined) {
      const anteriores = new Set(
        existente.asignadosIds.map((a) => a.toString()),
      );
      const nuevos = new Set(dto.asignadosIds);
      agregados = dto.asignadosIds.filter((a) => !anteriores.has(a));
      removidos = [...anteriores].filter((a) => !nuevos.has(a));
      // Only the newly added ones: someone who left keeps their old tasks.
      await this.exigirAsignablesValidos(agregados, copropiedadId);

      if (agregados.length > 0) {
        nuevasEntradas.push({
          accion: 'Asignó la tarea a nuevos responsables',
          usuario: actor,
          fecha: ahora,
        });
      }
      if (removidos.length > 0) {
        nuevasEntradas.push({
          accion: 'Quitó responsables de la tarea',
          usuario: actor,
          fecha: ahora,
        });
      }
    }

    // 3. Audit history: details edited.
    if (
      (dto.titulo && dto.titulo !== existente.titulo) ||
      (dto.descripcion !== undefined &&
        dto.descripcion !== existente.descripcion)
    ) {
      nuevasEntradas.push({
        accion: 'Actualizó los detalles de la tarea',
        usuario: actor,
        fecha: ahora,
      });
    }

    const operacion: Record<string, unknown> = { $set: cambios };
    if (nuevasEntradas.length > 0) {
      operacion.$push = { historial: { $each: nuevasEntradas } };
    }

    const actualizada = await this.tareas
      .findOneAndUpdate({ _id: id, copropiedadId }, operacion, { new: true })
      .exec();
    // Deleted between the read and the write.
    if (!actualizada) throw new NotFoundException(`Tarea ${id} no encontrada`);

    for (const accountId of agregados) {
      if (accountId !== user.accountId) {
        await this.notificarAsignacion(actualizada, copropiedadId, accountId);
      }
    }
    for (const accountId of removidos) {
      await this.notificarDesasignacion(actualizada, copropiedadId, accountId);
    }

    const poblada = await this.cargarPoblada(actualizada._id, copropiedadId);
    return toTarea(poblada ?? actualizada);
  }

  /**
   * True when the actor holds full task management rights (platform admin or
   * `tareas.gestionar`). Same check for the list's ownership filter and the
   * self-service actions.
   */
  private canManage(user: IRequestUser): boolean {
    return !!(
      user.isPlatformAdmin || user.permissions?.includes('tareas.gestionar')
    );
  }

  /**
   * Shared fetch+authorize step of the self-service actions (`completar` /
   * `agregarObservacion`): loads the task scoped to the active tenant (404 if
   * absent), then checks the caller is a manager or an assignee (403
   * otherwise). Returns the manager flag too, so callers fold the ownership
   * check into their write filter and close the gap between this read and the
   * atomic update (TOCTOU).
   */
  private async cargarTareaAutorizada(
    id: string,
    copropiedadId: Types.ObjectId,
    user: IRequestUser,
  ): Promise<{ tarea: TareaDocument; esGestor: boolean }> {
    this.validarId(id);
    const tarea = await this.tareas.findOne({ _id: id, copropiedadId }).exec();
    if (!tarea) throw new NotFoundException(`Tarea ${id} no encontrada`);

    const esGestor = this.canManage(user);
    const esAsignado = tarea.asignadosIds.some(
      (asignado) => asignado.toString() === user.accountId,
    );
    if (!esGestor && !esAsignado) {
      throw new ForbiddenException(
        'No tenés permiso para realizar esta acción sobre la tarea',
      );
    }
    return { tarea, esGestor };
  }

  /**
   * The filter of a self-service write: managers match on tenant + id alone;
   * everyone else must ALSO still be an assignee at write time. An equality
   * filter on the array field means "contains", so it holds for several
   * assignees. A write that returns null despite the earlier authorization
   * means the assignee list changed in the race window.
   */
  private filtroDeEscritura(
    id: string,
    copropiedadId: Types.ObjectId,
    esGestor: boolean,
    user: IRequestUser,
  ): Record<string, unknown> {
    if (esGestor) return { _id: id, copropiedadId };
    // Unreachable after the assignee check (it compares against the same id),
    // but a missing id must never turn into a filter that matches anyone.
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException(
        'No se pudo identificar la cuenta del usuario',
      );
    }
    return {
      _id: id,
      copropiedadId,
      asignadosIds: new Types.ObjectId(user.accountId),
    };
  }

  /**
   * Marks a task as completed. Self-service for an assignee (via
   * `tareas.actualizar`); a manager can complete any task of the tenant. Atomic
   * `$set` + `$push`, never a read-modify-write of the whole history, so
   * concurrent writers can't clobber each other's entries.
   */
  async completar(id: string, user: IRequestUser): Promise<TareaContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const { esGestor } = await this.cargarTareaAutorizada(
      id,
      copropiedadId,
      user,
    );

    const actualizada = await this.tareas
      .findOneAndUpdate(
        this.filtroDeEscritura(id, copropiedadId, esGestor, user),
        {
          $set: { estado: 'completado', progreso: 100 },
          $push: {
            historial: {
              accion: 'Completó la tarea',
              usuario: user.nombre || 'Usuario',
              fecha: new Date(),
            },
          },
        },
        { new: true },
      )
      .exec();

    if (!actualizada) {
      // Authorized moments ago, but the assignment changed before the write
      // landed: the safe, accurate read is "unauthorized", not 404.
      throw new ForbiddenException(
        'No tenés permiso para completar esta tarea',
      );
    }

    const poblada = await this.cargarPoblada(actualizada._id, copropiedadId);
    return toTarea(poblada ?? actualizada);
  }

  /**
   * Adds a free-text observation (does not change the state). Same access as
   * `completar`. Atomic `$push` of the observation and its history line, so two
   * people commenting at once can't drop each other's entry.
   */
  async agregarObservacion(
    id: string,
    texto: string,
    user: IRequestUser,
  ): Promise<TareaContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const { esGestor } = await this.cargarTareaAutorizada(
      id,
      copropiedadId,
      user,
    );

    // The observation records its author by account id.
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException(
        'No se pudo identificar la cuenta del usuario para registrar la observación',
      );
    }

    const ahora = new Date();
    const actualizada = await this.tareas
      .findOneAndUpdate(
        this.filtroDeEscritura(id, copropiedadId, esGestor, user),
        {
          $push: {
            observaciones: {
              texto,
              autorId: new Types.ObjectId(user.accountId),
              fecha: ahora,
            },
            historial: {
              accion: 'Agregó una observación',
              usuario: user.nombre || 'Usuario',
              fecha: ahora,
            },
          },
        },
        { new: true },
      )
      .exec();

    if (!actualizada) {
      throw new ForbiddenException(
        'No tenés permiso para agregar observaciones a esta tarea',
      );
    }

    const poblada = await this.cargarPoblada(actualizada._id, copropiedadId);
    return toTarea(poblada ?? actualizada);
  }

  /** Deletes a task of the active coproperty; 404 when there is none. */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.tareas
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento) throw new NotFoundException(`Tarea ${id} no encontrada`);
    return { id };
  }
}
