// src/modules/terceros/terceros.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import { resolverNombreTercero } from '../../common/utils/tercero-name.utils';
import type { Tercero as TerceroContract, Paginado } from '../../contracts';
import { toTercero } from './terceros.mapper';
import type { ListarTercerosDto } from './dto/listar-terceros.dto';
import type {
  ActualizarTerceroDto,
  CrearTerceroDto,
} from './dto/guardar-tercero.dto';

@Injectable()
export class TercerosService {
  constructor(
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Lists the parties of the active coproperty.
   *
   * The filter starts from the tenant and nothing else can remove it — see
   * the tenancy law. Every other condition is added on top.
   */
  async findAll(query: ListarTercerosDto): Promise<Paginado<TerceroContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };

    if (query.estado !== 'todos') {
      filtro.status = query.estado === 'inactivo' ? 'inactive' : 'active';
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      filtro.$or = [{ name: patron }, { identificationNumber: patron }];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.terceros
        .find(filtro)
        .sort({ name: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.terceros.countDocuments(filtro).exec(),
    ]);

    return { items: documentos.map(toTercero), total, pagina, porPagina };
  }

  /**
   * One party, scoped to the active coproperty.
   *
   * The tenant is part of the query, not checked afterwards — fetching by id
   * and comparing after would still have read another building's row.
   */
  async findOne(id: string): Promise<TerceroContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const documento = await this.terceros
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró el tercero ${id}`);
    }
    return toTercero(documento);
  }

  /**
   * Creates a party in the active coproperty.
   *
   * The tenant is taken from the context and written here, never read from
   * the body — a caller must not be able to create a party inside another
   * building.
   */
  async create(dto: CrearTerceroDto): Promise<TerceroContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (dto.numeroIdentificacion) {
      const yaExiste = await this.terceros
        .exists({
          coPropertyId,
          identificationNumber: dto.numeroIdentificacion,
        })
        .exec();
      if (yaExiste) {
        throw new ConflictException(
          `Ya existe un tercero con la identificación ${dto.numeroIdentificacion} en esta copropiedad`,
        );
      }
    }

    const nombre = resolverNombreTercero({
      tipoPersona: dto.tipoPersona,
      nombre: dto.nombre,
      nom1: dto.nom1,
      nom2: dto.nom2,
      ape1: dto.ape1,
      ape2: dto.ape2,
      razonSocial: dto.razonSocial,
    });
    if (!nombre) {
      throw new ConflictException(
        dto.tipoPersona === 'juridica'
          ? 'Debe indicar la razón social'
          : 'Debe indicar primer nombre y primer apellido',
      );
    }

    const creado = await this.terceros.create({
      ...this.aDocumento(dto),
      name: nombre,
      coPropertyId,
    });
    return toTercero(creado);
  }

  /**
   * Edits a party of the active coproperty.
   *
   * There is no way to retire one through this method — see the note on
   * `ActualizarTerceroDto`. A document issued in the past must keep naming
   * somebody, not point at nothing, and unlike `Inmueble` a party has no
   * "never billed yet" escape hatch either, so there is no delete.
   */
  async update(
    id: string,
    dto: ActualizarTerceroDto,
  ): Promise<TerceroContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (dto.numeroIdentificacion) {
      const chocaConOtro = await this.terceros
        .exists({
          coPropertyId,
          identificationNumber: dto.numeroIdentificacion,
          _id: { $ne: id },
        })
        .exec();
      if (chocaConOtro) {
        throw new ConflictException(
          `Ya existe otro tercero con la identificación ${dto.numeroIdentificacion} en esta copropiedad`,
        );
      }
    }

    const doc = this.aDocumento(dto);

    // `name` is recomputed only when a field it depends on is actually
    // touched — an edit to, say, `emails` costs no extra read. When one IS
    // touched, the untouched parts still count: patching only `nom2` must
    // not blank out `nom1`/`ape1` from the resulting `name`, so the current
    // document is read and merged in before recomputing.
    const tocaNombre =
      dto.tipoPersona !== undefined ||
      dto.nombre !== undefined ||
      dto.nom1 !== undefined ||
      dto.nom2 !== undefined ||
      dto.ape1 !== undefined ||
      dto.ape2 !== undefined ||
      dto.razonSocial !== undefined;

    if (tocaNombre) {
      const actual = await this.terceros
        .findOne({ _id: id, coPropertyId })
        .exec();
      if (!actual) {
        throw new NotFoundException(`No se encontró el tercero ${id}`);
      }

      const tipoPersona = dto.tipoPersona ?? actual.personType;
      const nombre = resolverNombreTercero({
        tipoPersona,
        nombre: dto.nombre ?? actual.name,
        nom1: dto.nom1 ?? actual.firstName ?? undefined,
        nom2: dto.nom2 ?? actual.middleName ?? undefined,
        ape1: dto.ape1 ?? actual.firstLastName ?? undefined,
        ape2: dto.ape2 ?? actual.secondLastName ?? undefined,
        razonSocial: dto.razonSocial ?? actual.businessName ?? undefined,
      });
      if (!nombre) {
        throw new ConflictException(
          tipoPersona === 'juridica'
            ? 'Debe indicar la razón social'
            : 'Debe indicar primer nombre y primer apellido',
        );
      }
      doc.name = nombre;
    }

    const actualizado = await this.terceros
      .findOneAndUpdate(
        { _id: id, coPropertyId },
        { $set: doc },
        { returnDocument: 'after' },
      )
      .exec();

    if (!actualizado) {
      throw new NotFoundException(`No se encontró el tercero ${id}`);
    }
    return toTercero(actualizado);
  }

  /**
   * Translates the Spanish payload into the English document shape. Only
   * keys the caller actually sent are included — spreading the DTO whole
   * would write `undefined` over fields nobody meant to clear.
   */
  private aDocumento(dto: ActualizarTerceroDto): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    const set = (clave: string, valor: unknown): void => {
      if (valor !== undefined) doc[clave] = valor;
    };

    set('personType', dto.tipoPersona);
    // `name` is NOT set here — `create`/`update` compute it via
    // `resolverNombre` and set it explicitly, after this method returns.
    set('firstName', dto.nom1);
    set('middleName', dto.nom2);
    set('firstLastName', dto.ape1);
    set('secondLastName', dto.ape2);
    set('businessName', dto.razonSocial);
    set('identificationType', dto.tipoIdentificacion);
    set('identificationNumber', dto.numeroIdentificacion);
    set('identificationVerificationDigit', dto.digitoVerificacion);
    set('emails', dto.emails);
    set('phone', dto.telefono);
    set('address', dto.direccion);
    set('city', dto.ciudad);
    set('cityCode', dto.ciudadCodigo);
    set('cityDepartmentCode', dto.ciudadDepartamentoCodigo);
    set('einvoiceIdentificationType', dto.facturacionTipoIdentificacion);
    set('einvoiceIdentificationNumber', dto.facturacionNumeroIdentificacion);
    set('einvoiceVerificationDigit', dto.facturacionDigitoVerificacion);
    set('ciiuCode', dto.codigoCiiu);
    set('salesRegime', dto.regimenVentas);
    set('fiscalResponsibilities', dto.responsabilidadesFiscales);
    set('withholdsIncomeTax', dto.retieneRenta);
    set('withholdsLocalTax', dto.retieneIca);

    return doc;
  }
}
