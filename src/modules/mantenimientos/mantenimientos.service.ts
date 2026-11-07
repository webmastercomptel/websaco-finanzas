// src/modules/mantenimientos/mantenimientos.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { siguienteCodigo } from '../../common/consecutivos/codigo-consecutivo';
import { DirectorioService } from '../../common/directorio/directorio.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  Mantenimiento as MantenimientoContrato,
  MantenimientosStats,
} from '../../contracts';
import {
  ConsecutivoAdministracion,
  type ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  Mantenimiento,
  TIPOS_MANTENIMIENTO,
  type MantenimientoDocument,
} from '../../database/schemas/administracion/mantenimiento.schema';
import {
  Tecnico,
  type TecnicoDocument,
} from '../../database/schemas/administracion/tecnico.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import type { ActualizarMantenimientoDto } from './dto/actualizar-mantenimiento.dto';
import type {
  CrearMantenimientoDto,
  ProveedorMantenimientoDto,
} from './dto/guardar-mantenimiento.dto';
import type { ListarMantenimientosDto } from './dto/listar-mantenimientos.dto';
import { construirCorreoMantenimientoAsignado } from './mantenimiento-correo';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toMantenimiento,
  type ProveedorResuelto,
} from './mantenimientos.mapper';

/** A provider resolved server-side, plus the email to notify (null when there is none). */
interface ProveedorConCorreo extends ProveedorResuelto {
  correoTecnico: string | null;
}

/**
 * Maintenance jobs of the ACTIVE coproperty. The tenant always comes from the
 * request context; every lookup and write filters by id AND `copropiedadId`,
 * so a maintenance (or technician) id of another building is a plain 404.
 */
@Injectable()
export class MantenimientosService {
  private readonly logger = new Logger(MantenimientosService.name);

  constructor(
    @InjectModel(Mantenimiento.name)
    private readonly mantenimientos: Model<MantenimientoDocument>,
    @InjectModel(ConsecutivoAdministracion.name)
    private readonly consecutivos: Model<ConsecutivoAdministracionDocument>,
    @InjectModel(Tecnico.name)
    private readonly tecnicos: Model<TecnicoDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Mantenimiento ${id} no encontrado`);
    }
  }

  /**
   * Turns the client's `proveedor` into a persistable shape. With `tecnicoId`
   * the technician is looked up by id AND coproperty, and name and email come
   * from that record, never from the client, so the snapshot can't drift from
   * the catalog it was picked from (and a technician of another building is a
   * 404). Without it, a free-typed `nombre` is required.
   */
  private async resolverProveedor(
    copropiedadId: Types.ObjectId,
    dto: ProveedorMantenimientoDto,
  ): Promise<ProveedorConCorreo> {
    if (dto.tecnicoId) {
      const tecnico = Types.ObjectId.isValid(dto.tecnicoId)
        ? await this.tecnicos
            .findOne({ _id: dto.tecnicoId, copropiedadId })
            .exec()
        : null;
      if (!tecnico) throw new NotFoundException('Técnico no encontrado');
      return {
        nombre: tecnico.nombre,
        tecnicoId: tecnico._id,
        correoTecnico: tecnico.email || null,
      };
    }
    if (!dto.nombre) {
      throw new BadRequestException(
        'Indicá un técnico del catálogo o el nombre del proveedor',
      );
    }
    return { nombre: dto.nombre, tecnicoId: null, correoTecnico: null };
  }

  /**
   * Best-effort: tells the technician a job was scheduled for them. Never
   * throws: a delivery failure is logged, not surfaced, since the maintenance
   * itself already exists.
   *
   * The email ALWAYS goes to the address on file (an external technician is
   * usually not a user and the message carries no app link, so it is plain, no
   * button). The in-app entry is only created when that address belongs to an
   * active back-office account of this coproperty that can read
   * `Mantenimiento`: a resident-only or unknown account has no maintenance
   * screen for the entry to lead to.
   */
  private async notificarTecnico(
    mantenimiento: MantenimientoDocument,
    copropiedadId: Types.ObjectId,
    correoTecnico: string,
  ): Promise<void> {
    try {
      // `findById` is allowed here: the id IS the tenant.
      const copropiedad = await this.copropiedades
        .findById(copropiedadId)
        .select('nombre')
        .exec();
      const { asunto, html } = construirCorreoMantenimientoAsignado({
        nombreTecnico: mantenimiento.proveedor.nombre,
        nombreCopropiedad: copropiedad?.nombre ?? '',
        titulo: mantenimiento.titulo,
        tipo: mantenimiento.tipo,
        fecha: mantenimiento.fecha,
        horario: mantenimiento.horario,
        ubicacion: mantenimiento.ubicacion,
        descripcion: mantenimiento.descripcion || undefined,
      });

      const enviado = await this.correo.enviar({
        para: correoTecnico,
        asunto,
        html,
      });
      if (!enviado) {
        this.logger.error(
          `No se pudo notificar el mantenimiento ${mantenimiento._id.toString()} a ${correoTecnico}.`,
        );
      }

      const destinatario = await this.directorio.destinatarioPorEmail(
        correoTecnico,
        copropiedadId,
        'Mantenimiento',
      );
      if (destinatario?.perfil === 'personal') {
        await this.notificaciones.crear({
          copropiedadId,
          accountId: destinatario.accountId,
          tipo: 'mantenimiento',
          titulo: asunto,
        });
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar el mantenimiento ${mantenimiento._id.toString()}: ${(error as Error).message}`,
      );
    }
  }

  /** Creates a maintenance in the active coproperty and returns the contract. */
  async crear(dto: CrearMantenimientoDto): Promise<MantenimientoContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const proveedor = await this.resolverProveedor(
      copropiedadId,
      dto.proveedor,
    );
    const codigo = await siguienteCodigo(this.consecutivos, 'MNT');
    const creado = await new this.mantenimientos({
      ...desdeCrearDto(dto, copropiedadId, proveedor),
      codigo,
    }).save();

    if (proveedor.correoTecnico) {
      await this.notificarTecnico(
        creado,
        copropiedadId,
        proveedor.correoTecnico,
      );
    }
    return toMantenimiento(creado);
  }

  /**
   * Lists the active coproperty's maintenances, newest date first, optionally
   * filtered by type and state (`todos`/`historial` mean no type filter).
   */
  async listar(
    filtros: ListarMantenimientosDto,
  ): Promise<MantenimientoContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    const { tipo, estado } = filtros;
    if (tipo && (TIPOS_MANTENIMIENTO as readonly string[]).includes(tipo)) {
      filtro.tipo = tipo;
    }
    if (estado && estado !== 'todos') filtro.estado = estado;

    const documentos = await this.mantenimientos
      .find(filtro)
      .sort({ fecha: -1 })
      .exec();
    return documentos.map(toMantenimiento);
  }

  /**
   * The three counters of the screen. Ported AS IS from the system this
   * replaces: despite the names `programadosSemana` and `completadosMes`, NO
   * date range is applied: they count every scheduled / completed job of the
   * coproperty, ever. Bounding them would change what the frontend shows, so it
   * is a product decision, not something to fix silently in a port.
   */
  async estadisticas(): Promise<MantenimientosStats> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [programadosSemana, enProgresoCorrective, completadosMes] =
      await Promise.all([
        this.mantenimientos
          .countDocuments({ copropiedadId, estado: 'programado' })
          .exec(),
        this.mantenimientos
          .countDocuments({
            copropiedadId,
            estado: 'en_progreso',
            tipo: 'correctivo',
          })
          .exec(),
        this.mantenimientos
          .countDocuments({ copropiedadId, estado: 'completado' })
          .exec(),
      ]);
    return { programadosSemana, enProgresoCorrective, completadosMes };
  }

  /**
   * Edits a maintenance. The provider is re-resolved only when the client sent
   * one, so a status change never touches the technician link.
   */
  async actualizar(
    id: string,
    dto: ActualizarMantenimientoDto,
  ): Promise<MantenimientoContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const proveedor = dto.proveedor
      ? await this.resolverProveedor(copropiedadId, dto.proveedor)
      : undefined;
    const documento = await this.mantenimientos
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: desdeActualizarDto(dto, proveedor) },
        { new: true },
      )
      .exec();
    if (!documento) {
      throw new NotFoundException(`Mantenimiento ${id} no encontrado`);
    }
    return toMantenimiento(documento);
  }

  /** Deletes a maintenance of the active coproperty; 404 when there is none. */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.mantenimientos
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`Mantenimiento ${id} no encontrado`);
    }
    return { id };
  }
}
