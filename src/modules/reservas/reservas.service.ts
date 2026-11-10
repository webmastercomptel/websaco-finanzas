// src/modules/reservas/reservas.service.ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  inicioDelDiaBogota,
  relojDeParedBogota,
} from '../../common/utils/reloj-bogota';
import type {
  DisponibilidadEspacio,
  Reserva as ReservaContrato,
  ReservaSolicitud,
  ReservasStats,
} from '../../contracts';
import {
  ESTADOS_RESERVA_ACTIVOS,
  ocupaFranja,
  Reserva,
  type ReservaDocument,
} from '../../database/schemas/administracion/reserva.schema';
import {
  Zona,
  type ZonaDocument,
} from '../../database/schemas/administracion/zona.schema';
import {
  PortalAccesoService,
  type UnidadPortal,
} from '../portal/portal-acceso.service';
import type { ActualizarEstadoReservaDto } from './dto/actualizar-estado-reserva.dto';
import type { CrearReservaDto } from './dto/guardar-reserva.dto';
import type { CrearReservaPortalDto } from './dto/guardar-reserva-portal.dto';
import {
  DURACION_MAXIMA_MS,
  estaEnCurso,
  franjasDe,
  horaUtc,
  horarioDeOperacion,
  HORAS_MINIMAS_PARA_CANCELAR,
  MS_POR_HORA,
} from './reservas-horario';
import { ReservasNotificacionesService } from './reservas-notificaciones.service';
import {
  nombreDeZona,
  poblarZona,
  toReserva,
  toReservaSolicitud,
} from './reservas.mapper';

const MENSAJE_CHOQUE = 'El espacio ya está reservado en ese horario';

/** Whether a Mongo error is a unique-index violation (code 11000). */
const esClaveDuplicada = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 11000;

/** What a new booking is made of, after the caller-specific parts are resolved. */
interface DatosReserva {
  autorId: Types.ObjectId | null;
  residente: string;
  unidad: string;
  inicio: Date;
  fin: Date;
  motivo: string | null;
}

/**
 * Reservations of common areas in the ACTIVE coproperty. The tenant always comes
 * from the request context; every lookup and write filters by id AND
 * `copropiedadId`, so a reservation or zone id of another building is a plain
 * 404.
 *
 * Two audiences use this service and the split is the security model:
 *
 * - Staff (`ReservasController`, CASL `approve Reserva` to write): see every
 *   booking, register one on somebody's behalf, and approve, reject or cancel.
 * - Residents (`ReservasPortalController`, `PortalGuard`, no CASL): request a
 *   booking from a unit they hold, see ONLY their own and cancel only those.
 *   Every `...Propia` / `...Residente` method narrows its filter by `autorId`,
 *   so somebody else's booking is indistinguishable from one that does not
 *   exist.
 *
 * Two bookings never share a minute of the same zone while both are `pendiente`
 * or `aprobada`: the overlap read below gives the friendly error, and a partial
 * unique index on `(zonaId, franjas)` (see the schema) makes it impossible even
 * when two requests race. Every state change is one atomic update of `estado`
 * AND `activa` on a tenant-scoped filter, never a read-modify-save.
 */
@Injectable()
export class ReservasService {
  constructor(
    @InjectModel(Reserva.name)
    private readonly reservas: Model<ReservaDocument>,
    @InjectModel(Zona.name)
    private readonly zonas: Model<ZonaDocument>,
    private readonly tenant: TenantContextService,
    private readonly portalAcceso: PortalAccesoService,
    private readonly notificaciones: ReservasNotificacionesService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Reserva ${id} no encontrada`);
    }
  }

  /**
   * The account behind a resident request. `PortalGuard` already requires one,
   * but "not an author" must never degrade into "matches everybody": without a
   * usable account id the request is refused.
   */
  private cuentaDelResidente(user: IRequestUser): Types.ObjectId {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException('No se pudo identificar tu cuenta');
    }
    return new Types.ObjectId(user.accountId);
  }

  /**
   * The zone being booked, looked up inside the tenant. A client-supplied
   * `espacioId` could name a zone of another coproperty, so it is never trusted.
   */
  private async cargarZona(
    espacioId: string,
    copropiedadId: Types.ObjectId,
  ): Promise<ZonaDocument> {
    if (!Types.ObjectId.isValid(espacioId)) {
      throw new NotFoundException('Espacio no encontrado');
    }
    const zona = await this.zonas
      .findOne({ _id: espacioId, copropiedadId })
      .exec();
    if (!zona) throw new NotFoundException('Espacio no encontrado');
    return zona;
  }

  /** Re-reads a booking WITH its zone's name, scoped by tenant like every lookup. */
  private async cargar(
    id: Types.ObjectId | string,
    copropiedadId: Types.ObjectId,
    soloDe?: Types.ObjectId,
  ): Promise<ReservaDocument | null> {
    return this.reservas
      .findOne({
        _id: id,
        copropiedadId,
        ...(soloDe && { autorId: soloDe }),
      })
      .populate(poblarZona(copropiedadId))
      .exec();
  }

  /** Parses and validates a booking interval; times are instants, not dates. */
  private leerIntervalo(
    inicioIso: string,
    finIso: string,
  ): { inicio: Date; fin: Date } {
    const inicio = new Date(inicioIso);
    const fin = new Date(finIso);
    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime())) {
      throw new BadRequestException('Fechas inválidas');
    }
    if (inicio >= fin) {
      throw new BadRequestException(
        'La hora de inicio debe ser anterior a la de fin',
      );
    }
    if (fin.getTime() - inicio.getTime() > DURACION_MAXIMA_MS) {
      throw new BadRequestException(
        'La reserva no puede durar más de 24 horas',
      );
    }
    return { inicio, fin };
  }

  /**
   * Persists a new `pendiente` booking and tells the staff who can read it.
   * Shared by both audiences: only who it is for and how that is resolved
   * differ.
   *
   * The overlap read reports the conflict early and with a clear message; the
   * unique index is what actually guarantees it, so a duplicate-key error from
   * the insert (two requests for the same minute at once) is the same 409.
   */
  private async registrar(
    zona: ZonaDocument,
    copropiedadId: Types.ObjectId,
    datos: DatosReserva,
    creadorId?: string,
  ): Promise<ReservaContrato> {
    const choque = await this.reservas.exists({
      copropiedadId,
      zonaId: zona._id,
      estado: { $in: [...ESTADOS_RESERVA_ACTIVOS] },
      inicio: { $lt: datos.fin },
      fin: { $gt: datos.inicio },
    });
    if (choque) throw new ConflictException(MENSAJE_CHOQUE);

    let creada: ReservaDocument;
    try {
      creada = await new this.reservas({
        copropiedadId,
        zonaId: zona._id,
        ...datos,
        estado: 'pendiente',
        activa: true,
        franjas: franjasDe(datos.inicio, datos.fin),
      }).save();
    } catch (error: unknown) {
      if (esClaveDuplicada(error)) throw new ConflictException(MENSAJE_CHOQUE);
      throw error;
    }

    await this.notificaciones.notificarNueva(
      creada,
      zona.nombre,
      copropiedadId,
      creadorId,
    );
    const poblada = await this.cargar(creada._id, copropiedadId);
    return toReserva(poblada ?? creada);
  }

  // ─── Staff ─────────────────────────────────────────────────────────────

  /**
   * Registers a booking on somebody's behalf. It has no author account (nobody
   * to notify of the answer later), the resident name and unit are the free text
   * staff typed, and the staff member who registered it is not told about it.
   * It starts `pendiente` like any other: someone with the same permission
   * still has to approve it.
   */
  async crearComoPersonal(
    dto: CrearReservaDto,
    user: IRequestUser,
  ): Promise<ReservaContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const zona = await this.cargarZona(dto.espacioId, copropiedadId);
    const { inicio, fin } = this.leerIntervalo(dto.inicio, dto.fin);
    return this.registrar(
      zona,
      copropiedadId,
      {
        autorId: null,
        residente: dto.residente ?? '',
        unidad: dto.inmueble ?? '',
        inicio,
        fin,
        motivo: dto.motivo ?? null,
      },
      user.accountId,
    );
  }

  /** Every booking of the active coproperty, newest start first. */
  async listar(): Promise<ReservaContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documentos = await this.reservas
      .find({ copropiedadId })
      .populate(poblarZona(copropiedadId))
      .sort({ inicio: -1 })
      .exec();
    return documentos.map(toReserva);
  }

  /** The approval queue: pending, approved and rejected requests, soonest first. */
  async listarSolicitudes(): Promise<ReservaSolicitud[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documentos = await this.reservas
      .find({
        copropiedadId,
        estado: { $in: ['pendiente', 'aprobada', 'rechazada'] },
      })
      .populate(poblarZona(copropiedadId))
      .sort({ inicio: 1 })
      .exec();
    return documentos.map(toReservaSolicitud);
  }

  /**
   * Counters for the reservations header. Kept as the system this replaces
   * computed them: `reservasHoy` counts every booking that STARTS today
   * whatever its state, `enCurso` every one of those happening right now, and
   * `areaMasDemandada` ranks areas by all bookings ever made, cancelled or not.
   * "Today" and "now" are Bogotá's, on the wall-clock scale bookings are stored
   * in (see `reloj-bogota.ts`): at 22:00 in Bogotá it is still that day.
   */
  async estadisticas(): Promise<ReservasStats> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const ahora = relojDeParedBogota();
    const inicioDia = inicioDelDiaBogota();
    const finDia = new Date(inicioDia.getTime() + 24 * MS_POR_HORA);

    const [solicitudesPendientes, hoy, porArea, totalGeneral] =
      await Promise.all([
        this.reservas.countDocuments({ copropiedadId, estado: 'pendiente' }),
        this.reservas
          .find({ copropiedadId, inicio: { $gte: inicioDia, $lt: finDia } })
          .select('estado inicio fin')
          .exec(),
        this.reservas
          .aggregate<{ _id: Types.ObjectId; n: number }>([
            { $match: { copropiedadId } },
            { $group: { _id: '$zonaId', n: { $sum: 1 } } },
            { $sort: { n: -1 } },
            { $limit: 1 },
          ])
          .exec(),
        this.reservas.countDocuments({ copropiedadId }),
      ]);

    // The name is read apart (not with `$lookup`) so it is tenant-scoped too.
    const cima = porArea[0] as { _id: Types.ObjectId; n: number } | undefined;
    const zonaCima = cima
      ? await this.zonas
          .findOne({ _id: cima._id, copropiedadId })
          .select('nombre')
          .exec()
      : null;

    return {
      solicitudesPendientes,
      reservasHoy: {
        total: hoy.length,
        confirmadas: hoy.filter((r) => r.estado === 'aprobada').length,
        enCurso: hoy.filter((r) => estaEnCurso(ahora, r.inicio, r.fin)).length,
      },
      areaMasDemandada: {
        nombre: zonaCima?.nombre ?? '—',
        porcentaje:
          cima && totalGeneral > 0
            ? Math.round((cima.n / totalGeneral) * 100)
            : 0,
      },
    };
  }

  /**
   * Approves, rejects or cancels a booking of the coproperty. One atomic update
   * of `estado` AND `activa` (the slot guard), conditioned on the booking not
   * being in that state already: a double click answers the current state
   * instead of repeating the email. Moving a rejected or cancelled booking back
   * to an active state re-claims its slots, so it is a 409 if somebody took them
   * meanwhile. The requester is told unless they are the one who acted.
   */
  async cambiarEstado(
    id: string,
    dto: ActualizarEstadoReservaDto,
    user: IRequestUser,
  ): Promise<ReservaContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();

    let actualizada: ReservaDocument | null;
    try {
      actualizada = await this.reservas
        .findOneAndUpdate(
          { _id: id, copropiedadId, estado: { $ne: dto.estado } },
          { $set: { estado: dto.estado, activa: ocupaFranja(dto.estado) } },
          { new: true },
        )
        .populate(poblarZona(copropiedadId))
        .exec();
    } catch (error: unknown) {
      if (esClaveDuplicada(error)) throw new ConflictException(MENSAJE_CHOQUE);
      throw error;
    }

    if (!actualizada) {
      const existente = await this.cargar(id, copropiedadId);
      if (!existente)
        throw new NotFoundException(`Reserva ${id} no encontrada`);
      return toReserva(existente);
    }

    await this.notificaciones.notificarRespuesta(
      actualizada,
      nombreDeZona(actualizada.zonaId),
      copropiedadId,
      dto.estado,
      user.accountId,
    );
    return toReserva(actualizada);
  }

  // ─── Shared reads ──────────────────────────────────────────────────────

  /**
   * What is taken on one UTC day for one area, plus its operating hours (read
   * from the zone's free-text schedule). Only bookings that START that day are
   * listed, as in the system this replaces. Operating hours are informational:
   * a booking outside them is not rejected.
   */
  async disponibilidad(
    espacioId: string,
    fecha: string,
  ): Promise<DisponibilidadEspacio> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const zona = await this.cargarZona(espacioId, copropiedadId);

    const inicioDia = new Date(fecha);
    if (Number.isNaN(inicioDia.getTime())) {
      throw new BadRequestException('Fecha inválida');
    }
    inicioDia.setUTCHours(0, 0, 0, 0);
    const finDia = new Date(inicioDia);
    finDia.setUTCDate(finDia.getUTCDate() + 1);

    const ocupadas = await this.reservas
      .find({
        copropiedadId,
        zonaId: zona._id,
        estado: { $in: [...ESTADOS_RESERVA_ACTIVOS] },
        inicio: { $gte: inicioDia, $lt: finDia },
      })
      .select('inicio fin')
      .sort({ inicio: 1 })
      .exec();

    return {
      horarioOperacion: horarioDeOperacion(zona.horario),
      ocupados: ocupadas.map((r) => ({
        inicio: horaUtc(r.inicio),
        fin: horaUtc(r.fin),
      })),
    };
  }

  // ─── Resident ──────────────────────────────────────────────────────────

  /**
   * The unit a resident books under: one of the units they actually hold, found
   * through the same derivation as the rest of the portal. Without this a client
   * could write any unit text. A resident with a single unit may omit it.
   */
  private resolverUnidad(
    pedida: string | undefined,
    unidades: UnidadPortal[],
  ): UnidadPortal {
    const codigo = pedida?.trim();
    if (!codigo) {
      if (unidades.length === 1) return unidades[0];
      throw new BadRequestException(
        unidades.length === 0
          ? 'No tenés inmuebles en esta copropiedad'
          : 'Indicá desde qué inmueble reservás',
      );
    }
    const unidad = unidades.find(
      (u) => u.codigo.toLowerCase() === codigo.toLowerCase(),
    );
    if (!unidad) {
      throw new ForbiddenException(
        'El inmueble indicado no es uno de los tuyos',
      );
    }
    return unidad;
  }

  /**
   * Requests a booking as a resident. Who it is for (author account, name, unit
   * code) is resolved here, never read from the payload, and it starts
   * `pendiente`. On top of the rules every booking obeys (no overlap, at most 24
   * hours), a resident's request must start in the future (a past one would be
   * swept as expired within the hour), be for a zone that takes reservations
   * and is not closed for maintenance, and be their only active booking of that
   * zone (one not yet finished, `pendiente` or `aprobada`).
   *
   * Residual race, accepted: that last rule is a count followed by an insert, so
   * two requests of the SAME resident for DIFFERENT times of the same zone
   * landing together can both pass. It cannot be a unique index (a finished
   * booking must stop counting while it stays `aprobada`) and the damage is one
   * extra request staff can reject; overlaps, the part that matters, are
   * guarded atomically.
   */
  async crearComoResidente(
    dto: CrearReservaPortalDto,
    user: IRequestUser,
  ): Promise<ReservaContrato> {
    const autorId = this.cuentaDelResidente(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const zona = await this.cargarZona(dto.espacioId, copropiedadId);
    const { inicio, fin } = this.leerIntervalo(dto.inicio, dto.fin);

    // Stored times are the Bogotá wall clock as UTC: compare on that scale.
    const ahora = relojDeParedBogota();
    if (inicio <= ahora) {
      throw new BadRequestException('La reserva debe comenzar en el futuro');
    }
    if (
      !zona.requiereReserva ||
      zona.estado === 'mantenimiento' ||
      zona.estado === 'cerrada'
    ) {
      throw new BadRequestException(
        'Este espacio no está disponible para reservar',
      );
    }

    const unidades = await this.portalAcceso.unidadesDe(
      autorId.toString(),
      copropiedadId.toString(),
    );
    const unidad = this.resolverUnidad(dto.inmueble, unidades);

    const vigentes = await this.reservas.countDocuments({
      copropiedadId,
      autorId,
      zonaId: zona._id,
      estado: { $in: [...ESTADOS_RESERVA_ACTIVOS] },
      fin: { $gt: ahora },
    });
    if (vigentes >= 1) {
      throw new BadRequestException(
        'Ya tenés una reserva activa para este espacio. Esperá a que finalice o cancelala para reservar nuevamente.',
      );
    }

    return this.registrar(zona, copropiedadId, {
      autorId,
      residente: user.nombre?.trim() || 'Residente',
      unidad: unidad.codigo,
      inicio,
      fin,
      motivo: dto.motivo ?? null,
    });
  }

  /** Only the bookings the caller requested, newest start first. */
  async listarPropias(user: IRequestUser): Promise<ReservaContrato[]> {
    const autorId = this.cuentaDelResidente(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documentos = await this.reservas
      .find({ copropiedadId, autorId })
      .populate(poblarZona(copropiedadId))
      .sort({ inicio: -1 })
      .exec();
    return documentos.map(toReserva);
  }

  /**
   * Cancels the caller's own `pendiente` or `aprobada` booking, at least
   * `HORAS_MINIMAS_PARA_CANCELAR` hours before it starts. Author, state and
   * lead time all live INSIDE the update filter, so the answer cannot be stale:
   * the cancellation and its checks are one atomic step, and a booking that
   * staff answered a millisecond earlier is judged on its new state. When
   * nothing matched, a read only tells WHY: not the caller's (404, the same as
   * non-existent), no longer cancellable (400), or too close to its start (400).
   * Nobody is notified: the resident did it themselves, as before.
   */
  async cancelarPropia(
    id: string,
    user: IRequestUser,
  ): Promise<ReservaContrato> {
    this.validarId(id);
    const autorId = this.cuentaDelResidente(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    // Six hours before the typed start, both on the Bogotá wall-clock scale.
    const limite = new Date(
      relojDeParedBogota().getTime() +
        HORAS_MINIMAS_PARA_CANCELAR * MS_POR_HORA,
    );

    const cancelada = await this.reservas
      .findOneAndUpdate(
        {
          _id: id,
          copropiedadId,
          autorId,
          estado: { $in: [...ESTADOS_RESERVA_ACTIVOS] },
          inicio: { $gte: limite },
        },
        { $set: { estado: 'cancelada', activa: false } },
        { new: true },
      )
      .populate(poblarZona(copropiedadId))
      .exec();
    if (cancelada) return toReserva(cancelada);

    const existente = await this.reservas
      .findOne({ _id: id, copropiedadId, autorId })
      .select('estado')
      .exec();
    if (!existente) throw new NotFoundException(`Reserva ${id} no encontrada`);
    if (!ocupaFranja(existente.estado)) {
      throw new BadRequestException(
        'Solo podés cancelar reservas pendientes o aprobadas',
      );
    }
    throw new BadRequestException(
      `No podés cancelar una reserva con menos de ${HORAS_MINIMAS_PARA_CANCELAR} horas de anticipación`,
    );
  }
}
