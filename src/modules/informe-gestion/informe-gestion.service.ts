// src/modules/informe-gestion/informe-gestion.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { generarPdfInformeGestion } from '../../common/pdf/informe-gestion-pdf';
import type { SeccionesInformeGestion } from '../../common/pdf/informe-gestion-pdf';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  Actividad,
  ActividadDocument,
} from '../../database/schemas/administracion/actividad.schema';
import {
  Equipo,
  EquipoDocument,
} from '../../database/schemas/administracion/equipo.schema';
import {
  Mantenimiento,
  MantenimientoDocument,
} from '../../database/schemas/administracion/mantenimiento.schema';
import {
  Pqr,
  PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import {
  Tecnico,
  TecnicoDocument,
} from '../../database/schemas/administracion/tecnico.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import type { ConsultarInformeGestionDto } from './dto/consultar-informe-gestion.dto';
import {
  rangoDelPeriodo,
  validarPeriodo,
  type FilaActividad,
  type FilaMantenimiento,
  type FilaPqr,
} from './informe-gestion.resumen';

/** Lean shapes read here (only the fields the report needs). */
interface ActividadLean {
  fecha: Date;
  titulo: string;
  categoria: string;
  estado: string;
  participantesIds?: Types.ObjectId[];
}
interface MantenimientoLean {
  fecha: Date;
  titulo: string;
  tipo: string;
  estado: string;
  costoEstimado?: number | null;
  equipoId?: Types.ObjectId | null;
  tecnicoId?: Types.ObjectId | null;
  proveedor?: { nombre?: string } | null;
}
interface PqrLean {
  createdAt: Date;
  codigo: string;
  unidad: string;
  tipo: string;
  prioridad: string;
  estado: string;
}
interface NombreLean {
  _id: Types.ObjectId;
  nombre: string;
}

/**
 * Builds the «Soporte a infogestión» PDF: the period's activities,
 * maintenances and PQRs. The route gate is any-of; here each section is
 * decided per ability, and a model the caller may not read is never queried
 * (the builder prints nothing for an absent key, not even counts).
 */
@Injectable()
export class InformeGestionService {
  constructor(
    @InjectModel(Actividad.name)
    private readonly actividades: Model<ActividadDocument>,
    @InjectModel(Mantenimiento.name)
    private readonly mantenimientos: Model<MantenimientoDocument>,
    @InjectModel(Pqr.name)
    private readonly pqrs: Model<PqrDocument>,
    @InjectModel(Equipo.name)
    private readonly equipos: Model<EquipoDocument>,
    @InjectModel(Tecnico.name)
    private readonly tecnicos: Model<TecnicoDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly casl: CaslAbilityFactory,
  ) {}

  /**
   * `dto` is already shape-validated by the global ValidationPipe, which is
   * what `validarPeriodo` presupposes.
   */
  async generarPdf(
    user: IRequestUser,
    dto: ConsultarInformeGestionDto,
  ): Promise<Buffer> {
    const error = validarPeriodo(dto.desde, dto.hasta);
    if (error) throw new BadRequestException(error);

    const copropiedadId = this.tenant.resolveCoPropertyId();
    const copropiedad = await this.copropiedades.findById(copropiedadId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }

    const rango = rangoDelPeriodo(dto.desde, dto.hasta);
    const ability = this.casl.createForUser(user);
    const secciones: SeccionesInformeGestion = {};

    if (ability.can('read', 'Actividad')) {
      const filas = await this.actividades
        .find({
          copropiedadId,
          fecha: { $gte: rango.inicioUtc, $lt: rango.finUtcExclusivo },
        })
        .select('fecha titulo categoria estado participantesIds')
        .sort({ fecha: 1, _id: 1 })
        .lean<ActividadLean[]>()
        .exec();
      secciones.actividades = filas.map((a): FilaActividad => ({
        fecha: a.fecha,
        titulo: a.titulo,
        categoria: a.categoria,
        estado: a.estado,
        inscritos: a.participantesIds?.length ?? 0,
      }));
    }

    if (ability.can('read', 'Mantenimiento')) {
      const filas = await this.mantenimientos
        .find({
          copropiedadId,
          fecha: { $gte: rango.inicioUtc, $lt: rango.finUtcExclusivo },
        })
        .select(
          'fecha titulo tipo estado costoEstimado equipoId tecnicoId proveedor.nombre',
        )
        .sort({ fecha: 1, _id: 1 })
        .lean<MantenimientoLean[]>()
        .exec();
      secciones.mantenimientos = await this.filasMantenimiento(
        copropiedadId,
        filas,
      );
    }

    if (ability.can('read', 'Pqr')) {
      const filas = await this.pqrs
        .find({
          copropiedadId,
          createdAt: {
            $gte: rango.inicioBogota,
            $lt: rango.finBogotaExclusivo,
          },
        })
        .select('createdAt codigo unidad tipo prioridad estado')
        .sort({ createdAt: 1, _id: 1 })
        .lean<PqrLean[]>()
        .exec();
      secciones.pqr = filas.map((p): FilaPqr => ({
        fecha: p.createdAt,
        codigo: p.codigo,
        unidad: p.unidad,
        tipo: p.tipo,
        prioridad: p.prioridad,
        estado: p.estado,
      }));
    }

    return generarPdfInformeGestion(
      copropiedad,
      { desde: dto.desde, hasta: dto.hasta },
      secciones,
    );
  }

  /** Resolves equipo and técnico names in two tenant-scoped lookups. */
  private async filasMantenimiento(
    copropiedadId: Types.ObjectId,
    filas: MantenimientoLean[],
  ): Promise<FilaMantenimiento[]> {
    const equipoIds = [
      ...new Set(
        filas.flatMap((f) => (f.equipoId ? [f.equipoId.toString()] : [])),
      ),
    ].map((id) => new Types.ObjectId(id));
    const tecnicoIds = [
      ...new Set(
        filas.flatMap((f) => (f.tecnicoId ? [f.tecnicoId.toString()] : [])),
      ),
    ].map((id) => new Types.ObjectId(id));

    const [equipos, tecnicos] = await Promise.all([
      equipoIds.length
        ? this.equipos
            .find({ copropiedadId, _id: { $in: equipoIds } })
            .select('nombre')
            .lean<NombreLean[]>()
            .exec()
        : Promise.resolve([] as NombreLean[]),
      tecnicoIds.length
        ? this.tecnicos
            .find({ copropiedadId, _id: { $in: tecnicoIds } })
            .select('nombre')
            .lean<NombreLean[]>()
            .exec()
        : Promise.resolve([] as NombreLean[]),
    ]);
    const nombreEquipo = new Map(
      equipos.map((e) => [e._id.toString(), e.nombre]),
    );
    const nombreTecnico = new Map(
      tecnicos.map((t) => [t._id.toString(), t.nombre]),
    );

    return filas.map((f): FilaMantenimiento => {
      const equipoId = f.equipoId?.toString() ?? null;
      const tecnico = f.tecnicoId
        ? nombreTecnico.get(f.tecnicoId.toString())
        : undefined;
      return {
        fecha: f.fecha,
        titulo: f.titulo,
        tipo: f.tipo,
        equipo: equipoId ? (nombreEquipo.get(equipoId) ?? null) : null,
        responsable: tecnico ?? f.proveedor?.nombre ?? null,
        estado: f.estado,
        costoEstimado: f.costoEstimado ?? null,
        equipoId,
      };
    });
  }
}
