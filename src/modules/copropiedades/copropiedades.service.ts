// src/modules/copropiedades/copropiedades.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  Copropiedad as CopropiedadContract,
  Paginado,
} from '../../contracts';
import { toCopropiedad } from './copropiedades.mapper';
import type { ListarCopropiedadesDto } from './dto/listar-copropiedades.dto';
import type {
  ActualizarCopropiedadDto,
  CrearCopropiedadDto,
} from './dto/guardar-copropiedad.dto';
import { escapeRegex } from '../../common/utils/query.utils';

/**
 * Manages the platform's catalogue of coproperties.
 *
 * Deliberately NOT scoped by TenantContextService. A coproperty IS the tenant
 * — this service manages the definition of every tenant there is, so there is
 * no single active one to filter by. Access is restricted at the controller
 * by PlatformAdminGuard instead.
 */
@Injectable()
export class CopropiedadesService {
  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
  ) {}

  async findAll(
    query: ListarCopropiedadesDto,
  ): Promise<Paginado<CopropiedadContract>> {
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
      this.copropiedades
        .find(filtro)
        .populate('managingEntityId', 'name')
        .sort({ name: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.copropiedades.countDocuments(filtro).exec(),
    ]);

    return { items: documentos.map(toCopropiedad), total, pagina, porPagina };
  }

  async findOne(id: string): Promise<CopropiedadContract> {
    const documento = await this.copropiedades
      .findById(id)
      .populate('managingEntityId', 'name')
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la copropiedad ${id}`);
    }
    return toCopropiedad(documento);
  }

  async create(dto: CrearCopropiedadDto): Promise<CopropiedadContract> {
    const yaExiste = await this.copropiedades
      .exists({ code: dto.codigo })
      .exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una copropiedad con el código ${dto.codigo}`,
      );
    }

    const creada = await this.copropiedades.create(this.aDocumento(dto));
    // Re-read populated: the created document holds a raw id for the managing
    // entity, and the contract promises its name.
    return this.findOne(creada._id.toString());
  }

  /**
   * Edits a coproperty. There is deliberately no delete: `estado: 'inactivo'`
   * stops it being billed and keeps every invoice and receipt ever issued
   * against it readable, for the same reason nothing removes a financial
   * document.
   */
  async update(
    id: string,
    dto: ActualizarCopropiedadDto,
  ): Promise<CopropiedadContract> {
    if (dto.codigo) {
      const chocaConOtra = await this.copropiedades
        .exists({ code: dto.codigo, _id: { $ne: id } })
        .exec();
      if (chocaConOtra) {
        throw new ConflictException(
          `Ya existe otra copropiedad con el código ${dto.codigo}`,
        );
      }
    }

    const actualizada = await this.copropiedades
      .findByIdAndUpdate(id, { $set: this.aDocumento(dto) }, { new: true })
      .exec();

    if (!actualizada) {
      throw new NotFoundException(`No se encontró la copropiedad ${id}`);
    }
    return this.findOne(actualizada._id.toString());
  }

  /**
   * Translates the Spanish payload into the English document shape. Only keys
   * the caller actually sent are included — spreading the DTO whole would
   * write `undefined` over fields nobody meant to clear.
   *
   * A building has a managing company or it does not, never a partial state
   * of both, so setting one clears the other: naming a managing entity
   * retires the plain-text note, and setting that note detaches the building
   * from whatever company was on file. Neither field is who administers the
   * building day to day — that is always a real person, tracked in
   * Usuarios/Asignacion, present whether or not a company is on file here.
   */
  private aDocumento(dto: ActualizarCopropiedadDto): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('code', dto.codigo);
    set('name', dto.nombre);
    set('taxId', dto.nit);
    set('taxIdVerificationDigit', dto.digitoVerificacion);
    set('address', dto.direccion);
    set('city', dto.ciudad);
    set('phone', dto.telefono);
    set('email', dto.email);
    set('usesBuildingManagement', dto.usaGestionEdificios);
    set('receivablesAccount', dto.cuentaContableCartera);
    set('advancesAccount', dto.cuentaAnticipos);
    if (dto.estado !== undefined) {
      doc.status = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    if (dto.entidadAdministradoraId !== undefined) {
      doc.managingEntityId = dto.entidadAdministradoraId;
      doc.administratorName = null;
    } else if (dto.nombreAdministrador !== undefined) {
      doc.administratorName = dto.nombreAdministrador;
      doc.managingEntityId = null;
    }

    return doc;
  }
}
