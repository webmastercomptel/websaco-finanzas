// src/modules/anuncios/anuncios.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { Anuncio as AnuncioContrato } from '../../contracts';
import {
  Anuncio,
  type AnuncioDocument,
} from '../../database/schemas/administracion/anuncio.schema';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toAnuncio,
} from './anuncios.mapper';
import type { ActualizarAnuncioDto } from './dto/actualizar-anuncio.dto';
import type { CrearAnuncioDto } from './dto/guardar-anuncio.dto';
import type {
  ListarAnunciosDto,
  ListarAnunciosPortalDto,
} from './dto/listar-anuncios.dto';

/**
 * What a resident may see: everything except drafts. A draft that a resident
 * asks for by id is indistinguishable from one that does not exist (404).
 */
export const FILTRO_PUBLICADOS = {
  estado: { $in: ['enviando', 'enviado', 'fallido'] },
} as const;

/**
 * Fields a resident-facing read leaves out: the delivery progress is the
 * biggest part of the document and a resident never sees it, and the lease
 * token is internal.
 */
const SIN_PROGRESO = '-notificadosIds -correosEnviadosIds -tokenEnvio';

/**
 * Announcements of the ACTIVE coproperty. The tenant always comes from the
 * request context; every lookup and write filters by id AND `copropiedadId`, so
 * an announcement id of another building is a plain 404.
 *
 * Staff manage them (`AnunciosController`; delivery lives in
 * `AnunciosEntregaService`); residents read, like and open the published ones
 * (`AnunciosPortalController`). Residents never write anything but their own
 * like and a view.
 */
@Injectable()
export class AnunciosService {
  constructor(
    @InjectModel(Anuncio.name)
    private readonly anuncios: Model<AnuncioDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Anuncio ${id} no encontrado`);
    }
  }

  /** Creates a DRAFT; the author is the caller's account name, never client input. */
  async crear(
    dto: CrearAnuncioDto,
    user: IRequestUser,
  ): Promise<AnuncioContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const creado = await new this.anuncios(
      desdeCrearDto(dto, copropiedadId, user.nombre ?? ''),
    ).save();
    return toAnuncio(creado, { incluirEntrega: true });
  }

  /** Staff list: every state, newest first, with the delivery progress. */
  async listar(filtros: ListarAnunciosDto): Promise<AnuncioContrato[]> {
    const filtro: Record<string, unknown> = {
      copropiedadId: this.tenant.resolveCoPropertyId(),
    };
    if (filtros.categoria && filtros.categoria !== 'todos') {
      filtro.categoria = filtros.categoria;
    }
    if (filtros.estado && filtros.estado !== 'todos') {
      filtro.estado = filtros.estado;
    }
    const documentos = await this.anuncios
      .find(filtro)
      .sort({ createdAt: -1 })
      .exec();
    return documentos.map((d) => toAnuncio(d, { incluirEntrega: true }));
  }

  /**
   * Resident list: published announcements only, newest publication first, with
   * `likedByMe` for the caller. The delivery arrays are left out of the read —
   * they are the biggest part of the document and a resident never sees them.
   */
  async listarParaResidente(
    filtros: ListarAnunciosPortalDto,
    user: IRequestUser,
  ): Promise<AnuncioContrato[]> {
    const filtro: Record<string, unknown> = {
      copropiedadId: this.tenant.resolveCoPropertyId(),
      ...FILTRO_PUBLICADOS,
    };
    if (filtros.categoria && filtros.categoria !== 'todos') {
      filtro.categoria = filtros.categoria;
    }
    const documentos = await this.anuncios
      .find(filtro)
      .select(SIN_PROGRESO)
      .sort({ publicadoEn: -1 })
      .exec();
    // A caller with no account id never "liked" anything (fail closed).
    const cuentaId = user.accountId ?? '';
    return documentos.map((d) => toAnuncio(d, { cuentaId }));
  }

  /** Edits an announcement of the active coproperty (any state; the author stays). */
  async actualizar(
    id: string,
    dto: ActualizarAnuncioDto,
  ): Promise<AnuncioContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.anuncios
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: desdeActualizarDto(dto) },
        { new: true },
      )
      .exec();
    if (!documento) throw new NotFoundException(`Anuncio ${id} no encontrado`);
    return toAnuncio(documento, { incluirEntrega: true });
  }

  /**
   * Deletes an announcement of the active coproperty; 404 when there is none.
   * A delivery in flight notices the missing document at its next heartbeat and
   * stops, so deleting mid-send is safe.
   */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.anuncios
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento) throw new NotFoundException(`Anuncio ${id} no encontrado`);
    return { id };
  }

  /** The caller's account id as an ObjectId, or 400 when the account is not provisioned. */
  private cuentaDe(user: IRequestUser): Types.ObjectId {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new BadRequestException('Usuario no tiene cuenta asociada');
    }
    return new Types.ObjectId(user.accountId);
  }

  /** Counts one open of a PUBLISHED announcement; a draft is a 404. */
  async registrarVista(
    id: string,
    user: IRequestUser,
  ): Promise<AnuncioContrato> {
    this.validarId(id);
    const cuenta = this.cuentaDe(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.anuncios
      .findOneAndUpdate(
        { _id: id, copropiedadId, ...FILTRO_PUBLICADOS },
        { $inc: { vistas: 1 } },
        { new: true },
      )
      .select(SIN_PROGRESO)
      .exec();
    if (!documento) throw new NotFoundException(`Anuncio ${id} no encontrado`);
    return toAnuncio(documento, { cuentaId: cuenta.toString() });
  }

  /**
   * Toggles the caller's like, atomically. The system this replaces kept a row
   * per like plus a separate counter and had to roll one back when the other
   * failed. Here the likes are the `meGustaIds` array and the count is its
   * length, so there is nothing to drift:
   *
   * 1. Unlike: `$pull` on a published document that currently contains the caller.
   * 2. Like: `$addToSet` on a published document that does NOT contain the caller.
   * 3. If neither matched, a read tells "no such (published) announcement" (404)
   *    apart from a double click that already landed (reported as liked).
   */
  async alternarMeGusta(
    id: string,
    user: IRequestUser,
  ): Promise<AnuncioContrato> {
    this.validarId(id);
    const cuenta = this.cuentaDe(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const opciones = { new: true } as const;
    const base = { _id: id, copropiedadId, ...FILTRO_PUBLICADOS };

    const quito = await this.anuncios
      .findOneAndUpdate(
        { ...base, meGustaIds: cuenta },
        { $pull: { meGustaIds: cuenta } },
        opciones,
      )
      .select(SIN_PROGRESO)
      .exec();
    if (quito) return toAnuncio(quito, { cuentaId: cuenta.toString() });

    const puso = await this.anuncios
      .findOneAndUpdate(
        { ...base, meGustaIds: { $ne: cuenta } },
        { $addToSet: { meGustaIds: cuenta } },
        opciones,
      )
      .select(SIN_PROGRESO)
      .exec();
    if (puso) return toAnuncio(puso, { cuentaId: cuenta.toString() });

    const existente = await this.anuncios
      .findOne(base)
      .select(SIN_PROGRESO)
      .exec();
    if (!existente) throw new NotFoundException(`Anuncio ${id} no encontrado`);
    return toAnuncio(existente, { cuentaId: cuenta.toString() });
  }
}
