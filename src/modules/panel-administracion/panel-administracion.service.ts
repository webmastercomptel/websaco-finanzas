// src/modules/panel-administracion/panel-administracion.service.ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ResumenPanelAdministracion } from '../../contracts';
import {
  Anuncio,
  AnuncioDocument,
} from '../../database/schemas/administracion/anuncio.schema';
import {
  EstadoPqr,
  Pqr,
  PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import {
  Reserva,
  ReservaDocument,
} from '../../database/schemas/administracion/reserva.schema';
import {
  Tarea,
  TareaDocument,
} from '../../database/schemas/administracion/tarea.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import { FILTRO_PUBLICADOS } from '../anuncios/anuncios.service';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import {
  toComunicacion,
  toOcupacionReservas,
  toPqrSemanal,
} from './panel-administracion.mapper';
import type {
  FilaComunicacion,
  FilaDiaSemana,
  FilaEstadoReserva,
} from './panel-administracion.mapper';

/** PQR states that still need an answer; `resuelto` and `cerrado` are done. */
export const ESTADOS_PQR_ABIERTOS: EstadoPqr[] = [
  'urgente',
  'en_revision',
  'pendiente',
];

/** How many announcement teasers the dashboard shows. */
export const COMUNICACIONES_EN_PANEL = 3;

/**
 * The coproperties operate in Colombia: a PQR filed at 21:00 on a Monday is
 * already Tuesday in UTC, so the weekday is cut in the building's own zone.
 */
const ZONA_HORARIA = 'America/Bogota';

/**
 * Same rule as `TareasService`: platform admins and holders of
 * `tareas.gestionar` manage every task, everyone else only the ones assigned to
 * them. Repeated (not imported) because that method is private to its module.
 */
const gestionaTareas = (user: IRequestUser): boolean =>
  !!(user.isPlatformAdmin || user.permissions?.includes('tareas.gestionar'));

/**
 * Dashboard of the building-management (Administración) side, for staff and for
 * residents. It only READS data owned by the tasks, PQR, bookings, announcements
 * and access modules; it writes nothing.
 *
 * Staff (`resumenPersonal`): every block is decided by the caller's OWN
 * abilities, exactly like the financial global search decides per group. A
 * block the caller may not read is OMITTED (key absent) and its queries are
 * never issued, so no count of a subject they cannot read can leak; a permitted
 * block with no data answers zeros / `[]`.
 *
 * Residents (`resumenResidente`): residents carry no permissions, so the door is
 * `PortalGuard` and the scope is DATA-level: only published announcements and
 * the resident's OWN PQRs and bookings (`autorId`). Nothing financial and
 * nothing of anybody else ever goes into it.
 *
 * Every query leads with the tenant from the request context; the weekday
 * chart and the occupancy are `$group` over `copropiedadId`-prefixed indexes
 * (`estado`, `createdAt`, `inicio`), and every counter is a `countDocuments`.
 */
@Injectable()
export class PanelAdministracionService {
  constructor(
    @InjectModel(Anuncio.name)
    private readonly anuncios: Model<AnuncioDocument>,
    @InjectModel(Tarea.name) private readonly tareas: Model<TareaDocument>,
    @InjectModel(Pqr.name) private readonly pqrs: Model<PqrDocument>,
    @InjectModel(Reserva.name)
    private readonly reservas: Model<ReservaDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    private readonly tenant: TenantContextService,
    private readonly abilities: CaslAbilityFactory,
  ) {}

  /** Staff dashboard: each block gated by the caller's ability on its subject. */
  async resumenPersonal(
    user: IRequestUser,
  ): Promise<ResumenPanelAdministracion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const ability = this.abilities.createForUser(user);
    const puede = {
      usuarios: ability.can('read', 'Usuario'),
      anuncios: ability.can('read', 'Anuncio'),
      tareas: ability.can('read', 'Tarea'),
      pqr: ability.can('read', 'Pqr'),
      reservas: ability.can('read', 'Reserva'),
    };

    const [
      usuariosActivos,
      anunciosPublicados,
      comunicaciones,
      tareasPendientes,
      pqrAbiertas,
      pqrPorDia,
      reservasPorEstado,
    ] = await Promise.all([
      puede.usuarios ? this.contarUsuarios(copropiedadId) : undefined,
      puede.anuncios ? this.contarAnuncios(copropiedadId) : undefined,
      puede.anuncios ? this.ultimasComunicaciones(copropiedadId) : undefined,
      puede.tareas
        ? this.contarTareasPendientes(copropiedadId, user)
        : undefined,
      puede.pqr ? this.contarPqrAbiertas(copropiedadId) : undefined,
      puede.pqr ? this.pqrPorDia(copropiedadId) : undefined,
      puede.reservas ? this.reservasPorEstado(copropiedadId) : undefined,
    ]);

    return this.ensamblar({
      usuariosActivos,
      anunciosPublicados,
      comunicaciones,
      tareasPendientes,
      pqrAbiertas,
      pqrPorDia,
      reservasPorEstado,
    });
  }

  /**
   * Resident dashboard. The blocks are fixed by the profile, not by abilities
   * (a resident has none); what is scoped is the DATA: own PQRs and bookings.
   * No payment link, no balances, no tasks, no user count: those were either
   * financial or staff-only.
   */
  async resumenResidente(
    user: IRequestUser,
  ): Promise<ResumenPanelAdministracion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const autorId = this.cuentaDelResidente(user);

    const [
      anunciosPublicados,
      comunicaciones,
      pqrAbiertas,
      pqrPorDia,
      reservasPorEstado,
    ] = await Promise.all([
      this.contarAnuncios(copropiedadId),
      this.ultimasComunicaciones(copropiedadId),
      this.contarPqrAbiertas(copropiedadId, autorId),
      this.pqrPorDia(copropiedadId, autorId),
      this.reservasPorEstado(copropiedadId, autorId),
    ]);

    return this.ensamblar({
      anunciosPublicados,
      comunicaciones,
      pqrAbiertas,
      pqrPorDia,
      reservasPorEstado,
    });
  }

  /** Fail closed: a resident whose account id cannot be read sees nothing. */
  private cuentaDelResidente(user: IRequestUser): Types.ObjectId {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException('No se pudo identificar tu cuenta');
    }
    return new Types.ObjectId(user.accountId);
  }

  /**
   * Puts together only the blocks that were computed (`undefined` = not
   * permitted / not part of the profile), so absence and zero stay distinct.
   */
  private ensamblar(datos: {
    usuariosActivos?: number;
    anunciosPublicados?: number;
    comunicaciones?: FilaComunicacion[];
    tareasPendientes?: number;
    pqrAbiertas?: number;
    pqrPorDia?: FilaDiaSemana[];
    reservasPorEstado?: FilaEstadoReserva[];
  }): ResumenPanelAdministracion {
    const resumen: ResumenPanelAdministracion = {
      estadisticas: {
        ...(datos.usuariosActivos !== undefined
          ? { usuariosActivos: { valor: datos.usuariosActivos } }
          : {}),
        ...(datos.anunciosPublicados !== undefined
          ? { anunciosRecientes: { valor: datos.anunciosPublicados } }
          : {}),
        ...(datos.tareasPendientes !== undefined
          ? { tareasPendientes: { valor: datos.tareasPendientes } }
          : {}),
        ...(datos.pqrAbiertas !== undefined
          ? { pqrAbiertas: { valor: datos.pqrAbiertas } }
          : {}),
      },
    };
    if (datos.pqrPorDia) resumen.pqrSemanal = toPqrSemanal(datos.pqrPorDia);
    if (datos.reservasPorEstado) {
      resumen.reservas = toOcupacionReservas(datos.reservasPorEstado);
    }
    if (datos.comunicaciones) {
      resumen.comunicaciones = datos.comunicaciones.map(toComunicacion);
    }
    return resumen;
  }

  /**
   * Staff accounts with an active assignment directly to this coproperty. Not
   * the same population as the old "memberships" count: residents are not
   * assignments here (they are derived from the units they hold), and
   * company-wide staff hold an entity-scope assignment instead.
   */
  private contarUsuarios(copropiedadId: Types.ObjectId): Promise<number> {
    return this.asignaciones
      .countDocuments({
        copropiedadId,
        alcance: 'copropiedad',
        estado: 'active',
      })
      .exec();
  }

  /** Published announcements (a draft was never communicated to anybody). */
  private contarAnuncios(copropiedadId: Types.ObjectId): Promise<number> {
    return this.anuncios
      .countDocuments({ copropiedadId, ...FILTRO_PUBLICADOS })
      .exec();
  }

  private ultimasComunicaciones(
    copropiedadId: Types.ObjectId,
  ): Promise<FilaComunicacion[]> {
    return this.anuncios
      .find(
        { copropiedadId, ...FILTRO_PUBLICADOS },
        { categoria: 1, titulo: 1, publicadoEn: 1, contenido: 1 },
      )
      .sort({ publicadoEn: -1, _id: -1 })
      .limit(COMUNICACIONES_EN_PANEL)
      .lean<FilaComunicacion[]>()
      .exec();
  }

  /**
   * Pending tasks. A non-manager only counts the ones assigned to them, the
   * same narrowing the task list applies; with no usable account id the answer
   * is 0 without querying ("not a manager" must never degrade to "all").
   */
  private async contarTareasPendientes(
    copropiedadId: Types.ObjectId,
    user: IRequestUser,
  ): Promise<number> {
    const filtro: Record<string, unknown> = {
      copropiedadId,
      estado: 'pendiente',
    };
    if (!gestionaTareas(user)) {
      if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) return 0;
      filtro.asignadosIds = new Types.ObjectId(user.accountId);
    }
    return await this.tareas.countDocuments(filtro).exec();
  }

  private contarPqrAbiertas(
    copropiedadId: Types.ObjectId,
    autorId?: Types.ObjectId,
  ): Promise<number> {
    return this.pqrs
      .countDocuments({
        copropiedadId,
        estado: { $in: ESTADOS_PQR_ABIERTOS },
        ...(autorId ? { autorId } : {}),
      })
      .exec();
  }

  private pqrPorDia(
    copropiedadId: Types.ObjectId,
    autorId?: Types.ObjectId,
  ): Promise<FilaDiaSemana[]> {
    return this.pqrs
      .aggregate<FilaDiaSemana>([
        { $match: { copropiedadId, ...(autorId ? { autorId } : {}) } },
        {
          $group: {
            _id: { $dayOfWeek: { date: '$createdAt', timezone: ZONA_HORARIA } },
            n: { $sum: 1 },
          },
        },
      ])
      .exec();
  }

  private reservasPorEstado(
    copropiedadId: Types.ObjectId,
    autorId?: Types.ObjectId,
  ): Promise<FilaEstadoReserva[]> {
    return this.reservas
      .aggregate<FilaEstadoReserva>([
        { $match: { copropiedadId, ...(autorId ? { autorId } : {}) } },
        { $group: { _id: '$estado', n: { $sum: 1 } } },
      ])
      .exec();
  }
}
