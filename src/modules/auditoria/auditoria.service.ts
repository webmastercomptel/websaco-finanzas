import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import {
  RegistroAuditoria,
  RegistroAuditoriaDocument,
} from '../../database/schemas/auditoria/registro-auditoria.schema';
import { FiltrosAuditoriaDto } from './dto/filtros-auditoria.dto';

/**
 * Input for writing an audit entry.
 *
 * `entidadId` arrives as a string because every caller already has it as a
 * string from the mutation result — converting to ObjectId is the service's
 * job, not the caller's.
 */
export interface EntradaAuditoria {
  actorAccountId: string;
  actorNombre: string;
  accion: 'crear' | 'actualizar' | 'revertir' | 'reiniciar' | 'desmarcar';
  entidadTipo:
    | 'entidad-administradora'
    | 'copropiedad'
    | 'usuario'
    | 'lote-facturacion'
    | 'lote-contabilidad';
  entidadId: string;
  entidadEtiqueta: string;
}

/** A single page of audit log entries. */
export interface PaginaAuditoria {
  items: RegistroAuditoria[];
  total: number;
  pagina: number;
  porPagina: number;
}

/**
 * Owns both the write path (registrar) and the read path (findAll) for the
 * audit trail. One service, two call shapes — avoids a separate "writer"
 * class nobody else needs yet.
 */
@Injectable()
export class AuditoriaService {
  constructor(
    @InjectModel(RegistroAuditoria.name)
    private readonly registros: Model<RegistroAuditoriaDocument>,
  ) {}

  /**
   * Write a single audit entry. Called after (not before) the originating
   * mutation has succeeded — a log-write failure rejects the whole request.
   * Pass the caller's `session` to write it inside that same transaction,
   * so the operation and its log entry commit or roll back together.
   */
  async registrar(
    entrada: EntradaAuditoria,
    session?: ClientSession,
  ): Promise<void> {
    const registro = {
      actorAccountId: entrada.actorAccountId,
      actorNombre: entrada.actorNombre,
      accion: entrada.accion,
      entidadTipo: entrada.entidadTipo,
      entidadId: entrada.entidadId,
      entidadEtiqueta: entrada.entidadEtiqueta,
    };
    if (session) {
      await this.registros.create([registro], { session });
    } else {
      await this.registros.create(registro);
    }
  }

  /**
   * Filtered, paginated listing — serves both the dashboard's "last 10"
   * view (porPagina=10, no filters) and the full /logs page (real filters,
   * real pagination).
   *
   * Sorted by createdAt descending (most recent first).
   */
  async findAll(filtros: FiltrosAuditoriaDto): Promise<PaginaAuditoria> {
    const pagina = filtros.pagina ?? 1;
    const porPagina = filtros.porPagina ?? 50;

    const query: Record<string, unknown> = {};

    if (filtros.entidadTipo) {
      query.entidadTipo = filtros.entidadTipo;
    }
    if (filtros.accion) {
      query.accion = filtros.accion;
    }
    if (filtros.desde || filtros.hasta) {
      query.createdAt = {};
      if (filtros.desde) {
        (query.createdAt as Record<string, Date>).$gte = new Date(
          filtros.desde,
        );
      }
      if (filtros.hasta) {
        (query.createdAt as Record<string, Date>).$lte = new Date(
          filtros.hasta,
        );
      }
    }

    const [items, total] = await Promise.all([
      this.registros
        .find(query)
        .sort({ createdAt: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.registros.countDocuments(query).exec(),
    ]);

    return { items, total, pagina, porPagina };
  }
}
