// src/modules/busqueda-administracion/busqueda-administracion.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type { RespuestaBusquedaAdministracion } from '../../contracts';
import {
  Actividad,
  ActividadDocument,
} from '../../database/schemas/administracion/actividad.schema';
import {
  Anuncio,
  AnuncioDocument,
} from '../../database/schemas/administracion/anuncio.schema';
import {
  ArchivoDocumento,
  ArchivoDocumentoDocument,
} from '../../database/schemas/administracion/documento-archivo.schema';
import {
  AclCarpetaDocumento,
  CarpetaDocumento,
  CarpetaDocumentoDocument,
} from '../../database/schemas/administracion/documento-carpeta.schema';
import {
  BloqueFacturacion,
  BloqueFacturacionDocument,
} from '../../database/schemas/administracion/bloque-facturacion.schema';
import {
  Mantenimiento,
  MantenimientoDocument,
} from '../../database/schemas/administracion/mantenimiento.schema';
import {
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
  Zona,
  ZonaDocument,
} from '../../database/schemas/administracion/zona.schema';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { accesoDelPersonal } from '../documentos/documentos-acceso';
import { DocumentosActorService } from '../documentos/documentos-actor.service';
import { LIMITE_BUSQUEDA_ADMINISTRACION_POR_DEFECTO } from './dto/buscar-administracion.dto';
import type { BuscarAdministracionDto } from './dto/buscar-administracion.dto';
import {
  toResultadoActividad,
  toResultadoAnuncio,
  toResultadoBloque,
  toResultadoDocumento,
  toResultadoMantenimiento,
  toResultadoPqr,
  toResultadoReserva,
  toResultadoTarea,
  toResultadoZona,
} from './busqueda-administracion.mapper';
import type {
  FilaActividadBusqueda,
  FilaAnuncioBusqueda,
  FilaBloqueBusqueda,
  FilaDocumentoBusqueda,
  FilaMantenimientoBusqueda,
  FilaPqrBusqueda,
  FilaReservaBusqueda,
  FilaTareaBusqueda,
  FilaZonaBusqueda,
} from './busqueda-administracion.mapper';

/** Newest change first, as the source search ranked; `_id` breaks ties. */
const ORDEN = { updatedAt: -1, _id: -1 } as const;

/** A folder reduced to what the access rules read. */
interface FilaCarpeta {
  _id: Types.ObjectId;
  slug: string;
  carpetaPadreId: Types.ObjectId | null;
  acls?: AclCarpetaDocumento[];
}

/** Same rule as `TareasService`: only managers see every task. */
const gestionaTareas = (user: IRequestUser): boolean =>
  !!(user.isPlatformAdmin || user.permissions?.includes('tareas.gestionar'));

/**
 * Global search (Ctrl/Cmd+K) over the Administración records of the ACTIVE
 * coproperty. It is the building-management twin of the financial
 * `BusquedaService` and follows its contract: the route is one door onto
 * several subjects, so each group is decided here by its own CASL subject, a
 * group the caller may not read is OMITTED (key absent), and a permitted group
 * with no hits is `[]`.
 *
 * Beyond the subject, two groups narrow further so search never shows what the
 * module's own screen would not:
 *  - tareas: a non-manager only finds tasks assigned to them (as their list);
 *  - documentos: only files in folders the caller can read by the folder rules
 *    (`accesoDelPersonal`), because a file name is already a disclosure.
 *
 * The user text is escaped before it becomes a regex (a search box is input), is
 * bounded by the DTO, and every filter leads with the tenant from the request
 * context. Substring `$regex` cannot use an index beyond the `copropiedadId`
 * prefix, so the cost is bounded by one building's records and by `limite`.
 */
@Injectable()
export class BusquedaAdministracionService {
  constructor(
    @InjectModel(Tarea.name) private readonly tareas: Model<TareaDocument>,
    @InjectModel(Anuncio.name)
    private readonly anuncios: Model<AnuncioDocument>,
    @InjectModel(Pqr.name) private readonly pqrs: Model<PqrDocument>,
    @InjectModel(Mantenimiento.name)
    private readonly mantenimientos: Model<MantenimientoDocument>,
    @InjectModel(Actividad.name)
    private readonly actividades: Model<ActividadDocument>,
    @InjectModel(ArchivoDocumento.name)
    private readonly archivos: Model<ArchivoDocumentoDocument>,
    @InjectModel(CarpetaDocumento.name)
    private readonly carpetas: Model<CarpetaDocumentoDocument>,
    @InjectModel(Zona.name) private readonly zonas: Model<ZonaDocument>,
    @InjectModel(Reserva.name)
    private readonly reservas: Model<ReservaDocument>,
    @InjectModel(BloqueFacturacion.name)
    private readonly bloques: Model<BloqueFacturacionDocument>,
    private readonly tenant: TenantContextService,
    private readonly abilities: CaslAbilityFactory,
    private readonly actores: DocumentosActorService,
  ) {}

  async buscar(
    user: IRequestUser,
    dto: BuscarAdministracionDto,
  ): Promise<RespuestaBusquedaAdministracion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const ability = this.abilities.createForUser(user);
    const limite = dto.limite ?? LIMITE_BUSQUEDA_ADMINISTRACION_POR_DEFECTO;

    const puede = {
      tareas: ability.can('read', 'Tarea'),
      anuncios: ability.can('read', 'Anuncio'),
      pqr: ability.can('read', 'Pqr'),
      mantenimientos: ability.can('read', 'Mantenimiento'),
      actividades: ability.can('read', 'Actividad'),
      documentos: ability.can('read', 'Documento'),
      zonasComunes: ability.can('read', 'Zona'),
      reservas: ability.can('read', 'Reserva'),
      // Same gate as the block-billing screen's own list (`create Factura`).
      facturasBloque: ability.can('create', 'Factura'),
    };

    // Nothing readable: no query at all (the route's own gate normally stops
    // this first; this keeps the service safe if it is ever reused).
    if (!Object.values(puede).some(Boolean)) return {};

    // Escaped: an unescaped "(" throws, and a crafted pattern pins the database.
    const regex = { $regex: escapeRegex(dto.q), $options: 'i' };

    const [
      tareas,
      anuncios,
      pqr,
      mantenimientos,
      actividades,
      documentos,
      zonasComunes,
      reservas,
      facturasBloque,
    ] = await Promise.all([
      puede.tareas
        ? this.buscarTareas(copropiedadId, user, regex, limite)
        : undefined,
      puede.anuncios
        ? this.grupo<AnuncioDocument, FilaAnuncioBusqueda>(
            this.anuncios,
            {
              copropiedadId,
              $or: [{ titulo: regex }, { contenido: regex }, { autor: regex }],
            },
            { titulo: 1, contenido: 1 },
            limite,
          )
        : undefined,
      puede.pqr
        ? this.grupo<PqrDocument, FilaPqrBusqueda>(
            this.pqrs,
            {
              copropiedadId,
              $or: [
                { titulo: regex },
                { descripcion: regex },
                { descripcionCompleta: regex },
                { categoria: regex },
                { codigo: regex },
                { 'residente.nombre': regex },
              ],
            },
            { titulo: 1, descripcion: 1, descripcionCompleta: 1 },
            limite,
          )
        : undefined,
      puede.mantenimientos
        ? this.grupo<MantenimientoDocument, FilaMantenimientoBusqueda>(
            this.mantenimientos,
            {
              copropiedadId,
              $or: [
                { titulo: regex },
                { descripcion: regex },
                { codigo: regex },
                { 'proveedor.nombre': regex },
                { ubicacion: regex },
                { notas: regex },
              ],
            },
            { titulo: 1, descripcion: 1 },
            limite,
          )
        : undefined,
      puede.actividades
        ? this.grupo<ActividadDocument, FilaActividadBusqueda>(
            this.actividades,
            {
              copropiedadId,
              $or: [
                { titulo: regex },
                { descripcion: regex },
                { codigo: regex },
                { ubicacion: regex },
                { organizador: regex },
                { tags: regex },
              ],
            },
            { titulo: 1, descripcion: 1 },
            limite,
          )
        : undefined,
      puede.documentos
        ? this.buscarDocumentos(copropiedadId, user, regex, limite)
        : undefined,
      puede.zonasComunes
        ? this.grupo<ZonaDocument, FilaZonaBusqueda>(
            this.zonas,
            {
              copropiedadId,
              $or: [
                { nombre: regex },
                { codigo: regex },
                { descripcion: regex },
                { horario: regex },
              ],
            },
            { nombre: 1, descripcion: 1 },
            limite,
          )
        : undefined,
      puede.reservas
        ? this.grupo<ReservaDocument, FilaReservaBusqueda>(
            this.reservas,
            {
              copropiedadId,
              $or: [{ residente: regex }, { unidad: regex }, { motivo: regex }],
            },
            { residente: 1, unidad: 1, motivo: 1 },
            limite,
          )
        : undefined,
      puede.facturasBloque
        ? this.grupo<BloqueFacturacionDocument, FilaBloqueBusqueda>(
            this.bloques,
            {
              copropiedadId,
              $or: [{ nombre: regex }, { periodo: regex }, { tipo: regex }],
            },
            { nombre: 1, periodo: 1 },
            limite,
          )
        : undefined,
    ]);

    const respuesta: RespuestaBusquedaAdministracion = {};
    if (tareas) respuesta.tareas = tareas.map(toResultadoTarea);
    if (anuncios) respuesta.anuncios = anuncios.map(toResultadoAnuncio);
    if (pqr) respuesta.pqr = pqr.map(toResultadoPqr);
    if (mantenimientos) {
      respuesta.mantenimientos = mantenimientos.map(toResultadoMantenimiento);
    }
    if (actividades) {
      respuesta.actividades = actividades.map(toResultadoActividad);
    }
    if (documentos) respuesta.documentos = documentos;
    if (zonasComunes)
      respuesta.zonasComunes = zonasComunes.map(toResultadoZona);
    if (reservas) respuesta.reservas = reservas.map(toResultadoReserva);
    if (facturasBloque) {
      respuesta.facturasBloque = facturasBloque.map(toResultadoBloque);
    }
    return respuesta;
  }

  /** One capped, newest-first, projected query; the filter already carries the tenant. */
  private grupo<D, F>(
    modelo: Model<D>,
    filtro: Record<string, unknown>,
    proyeccion: Record<string, 1>,
    limite: number,
  ): Promise<F[]> {
    return modelo
      .find(filtro, proyeccion)
      .sort(ORDEN)
      .limit(limite)
      .lean<F[]>()
      .exec();
  }

  /**
   * Tasks. A non-manager only finds the ones assigned to them; with no usable
   * account id they find none (fail closed, never "all").
   */
  private async buscarTareas(
    copropiedadId: Types.ObjectId,
    user: IRequestUser,
    regex: { $regex: string; $options: string },
    limite: number,
  ): Promise<FilaTareaBusqueda[]> {
    const filtro: Record<string, unknown> = {
      copropiedadId,
      $or: [{ titulo: regex }, { descripcion: regex }],
    };
    if (!gestionaTareas(user)) {
      if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) return [];
      filtro.asignadosIds = new Types.ObjectId(user.accountId);
    }
    return await this.grupo<TareaDocument, FilaTareaBusqueda>(
      this.tareas,
      filtro,
      { titulo: 1, descripcion: 1 },
      limite,
    );
  }

  /**
   * Files whose folder the caller may read. Folders are loaded in ONE
   * tenant-filtered query and inheritance is resolved over that map (as the
   * document screen does), so the ancestor walk can never reach another
   * building's folder. No readable folder means no file query at all.
   */
  private async buscarDocumentos(
    copropiedadId: Types.ObjectId,
    user: IRequestUser,
    regex: { $regex: string; $options: string },
    limite: number,
  ): Promise<ReturnType<typeof toResultadoDocumento>[]> {
    const [actor, carpetas] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas
        .find({ copropiedadId }, { slug: 1, carpetaPadreId: 1, acls: 1 })
        .lean<FilaCarpeta[]>()
        .exec(),
    ]);
    const porId = new Map(carpetas.map((c) => [c._id.toString(), c]));
    const legibles = carpetas.filter(
      (c) => accesoDelPersonal(c, actor, porId).puedeLeer,
    );
    if (legibles.length === 0) return [];

    const filas = await this.grupo<
      ArchivoDocumentoDocument,
      FilaDocumentoBusqueda
    >(
      this.archivos,
      {
        copropiedadId,
        // Pending uploads are never listed anywhere; they are not findable.
        estado: 'listo',
        carpetaId: { $in: legibles.map((c) => c._id) },
        $or: [
          { nombre: regex },
          { codigo: regex },
          { categoria: regex },
          { autorNombre: regex },
          { etiquetas: regex },
        ],
      },
      { nombre: 1, categoria: 1, carpetaId: 1 },
      limite,
    );
    return filas.map((f) =>
      toResultadoDocumento(f, porId.get(f.carpetaId.toString())?.slug ?? ''),
    );
  }
}
