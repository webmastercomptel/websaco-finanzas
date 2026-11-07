// src/modules/notificaciones/notificaciones.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  Notificacion,
  NotificacionDocument,
  TipoNotificacion,
} from '../../database/schemas/administracion/notificacion.schema';
import type { Notificacion as NotificacionContrato } from '../../contracts';
import { toNotificacion } from './notificaciones.mapper';

/** The bell shows the latest entries; an inbox that only grows is not a feature. */
const MAXIMO_EN_BANDEJA = 100;

/**
 * The in-app inbox of the signed-in account in the ACTIVE coproperty. Every
 * read and write filters by both, so nobody sees or marks another person's
 * entries and a notification never crosses buildings.
 */
@Injectable()
export class NotificacionesService {
  private readonly logger = new Logger(NotificacionesService.name);

  constructor(
    @InjectModel(Notificacion.name)
    private readonly notificaciones: Model<NotificacionDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(user: IRequestUser): Promise<NotificacionContrato[]> {
    if (!user.accountId) return [];
    const documentos = await this.notificaciones
      .find({
        copropiedadId: this.tenant.resolveCoPropertyId(),
        accountId: new Types.ObjectId(user.accountId),
      })
      .sort({ createdAt: -1 })
      .limit(MAXIMO_EN_BANDEJA)
      .exec();
    return documentos.map(toNotificacion);
  }

  async marcarLeida(
    id: string,
    user: IRequestUser,
  ): Promise<NotificacionContrato> {
    if (!user.accountId || !Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Notificación ${id} no encontrada`);
    }
    const documento = await this.notificaciones
      .findOneAndUpdate(
        {
          _id: id,
          copropiedadId: this.tenant.resolveCoPropertyId(),
          accountId: new Types.ObjectId(user.accountId),
        },
        { leida: true },
        { new: true },
      )
      .exec();
    if (!documento) {
      throw new NotFoundException(`Notificación ${id} no encontrada`);
    }
    return toNotificacion(documento);
  }

  async marcarTodasLeidas(
    user: IRequestUser,
  ): Promise<{ actualizadas: number }> {
    if (!user.accountId) return { actualizadas: 0 };
    const resultado = await this.notificaciones
      .updateMany(
        {
          copropiedadId: this.tenant.resolveCoPropertyId(),
          accountId: new Types.ObjectId(user.accountId),
          leida: false,
        },
        { leida: true },
      )
      .exec();
    return { actualizadas: resultado.modifiedCount };
  }

  /**
   * Best-effort producer used by the other modules: one entry for one
   * recipient. It never throws — a failed write is logged, never surfaced, so
   * the PQR, task or reservation that triggered it is not put at risk by a side
   * effect. It answers whether the entry was stored, so a resumable delivery
   * records "notified" only when it really happened.
   */
  async crear(entrada: {
    copropiedadId: Types.ObjectId | string;
    accountId: Types.ObjectId | string;
    tipo: TipoNotificacion;
    titulo: string;
    descripcion?: string;
  }): Promise<boolean> {
    try {
      await this.notificaciones.create({
        copropiedadId: entrada.copropiedadId,
        accountId: entrada.accountId,
        tipo: entrada.tipo,
        titulo: entrada.titulo,
        descripcion: entrada.descripcion ?? '',
        leida: false,
      });
      return true;
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo crear la notificación (${entrada.tipo}) para ${String(entrada.accountId)}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
