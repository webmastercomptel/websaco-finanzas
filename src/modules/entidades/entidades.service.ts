// src/modules/entidades/entidades.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EntidadAdministradora,
  EntidadAdministradoraDocument,
} from '../../database/schemas/entidades/entidad-administradora.schema';
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
        .sort({ name: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.entidades.countDocuments(filtro).exec(),
    ]);

    return { items: documentos.map(toEntidad), total, pagina, porPagina };
  }

  async findOne(id: string): Promise<EntidadContract> {
    const documento = await this.entidades.findById(id).exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la entidad ${id}`);
    }
    return toEntidad(documento);
  }

  async create(dto: CrearEntidadDto): Promise<EntidadContract> {
    const yaExiste = await this.entidades.exists({ code: dto.codigo }).exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una entidad con el código ${dto.codigo}`,
      );
    }

    const creada = await this.entidades.create(this.aDocumento(dto));
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
  ): Promise<EntidadContract> {
    if (dto.codigo) {
      const chocaConOtra = await this.entidades
        .exists({ code: dto.codigo, _id: { $ne: id } })
        .exec();
      if (chocaConOtra) {
        throw new ConflictException(
          `Ya existe otra entidad con el código ${dto.codigo}`,
        );
      }
    }

    const actualizada = await this.entidades
      .findByIdAndUpdate(id, { $set: this.aDocumento(dto) }, { new: true })
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la entidad ${id}`);
    }
    return toEntidad(actualizada);
  }

  /**
   * Translates the Spanish payload into the English document shape. Only keys
   * the caller actually sent are included — spreading the DTO whole would
   * write `undefined` over fields nobody meant to clear.
   */
  private aDocumento(dto: ActualizarEntidadDto): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('code', dto.codigo);
    set('name', dto.nombre);
    set('taxId', dto.nit);
    set('taxIdVerificationDigit', dto.digitoVerificacion);
    set('email', dto.email);
    set('phone', dto.telefono);
    if (dto.estado !== undefined) {
      doc.status = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    return doc;
  }
}
