// src/modules/portal/portal.service.ts
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EnvioFactura,
  type EnvioFacturaDocument,
} from '../../database/schemas/facturacion/envio-factura.schema';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  Factura,
  PaginadoConTotales,
  TotalesFacturas,
} from '../../contracts';
import { paginaIndividualDeFactura } from '../facturacion/factura-pdf.util';
import { FacturasService } from '../facturacion/facturas.service';
import { EstadoCuentaService } from '../consultas/estado-cuenta.service';
import type {
  EstadoCuentaPortalDto,
  ListarFacturasPortalDto,
} from './dto/portal.dto';
import {
  PortalAccesoService,
  type RolPortal,
  type UnidadPortal,
} from './portal-acceso.service';

/** Most released invoices of one unit the portal lists (years of monthly billing). */
const MAX_LIBERADAS_POR_UNIDAD = 5000;

/**
 * What a resident (owner or tenant) may read, and nothing else: the invoices of
 * the units they hold and, for owners only, the statement of account. There is
 * deliberately no receipts method, and no listing across units: every call
 * names a unit and is checked against the units the caller really holds.
 *
 * A unit (or document) that is not the caller's answers 404 exactly like one
 * that does not exist, so ids of other people's units cannot be probed.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly acceso: PortalAccesoService,
    private readonly facturas: FacturasService,
    private readonly estadoCuenta: EstadoCuentaService,
    private readonly presentacionDocumento: PresentacionDocumentoService,
    private readonly storage: DocumentoStorageService,
    @InjectModel(EnvioFactura.name)
    private readonly envios: Model<EnvioFacturaDocument>,
  ) {}

  /** The caller's own units and their role on each. */
  unidades(user: IRequestUser): Promise<UnidadPortal[]> {
    return this.acceso.unidadesDe(user.accountId!, user.copropiedadId!);
  }

  /**
   * Invoices of one unit the caller holds (owner or tenant) THAT STAFF RELEASED:
   * an invoice is visible only after someone pressed "send" on it (see
   * `EnvioFactura.liberadaEn`), so a freshly issued invoice nobody reviewed yet
   * never shows up. Pagination is computed over the released set.
   */
  async facturasDe(
    user: IRequestUser,
    query: ListarFacturasPortalDto,
  ): Promise<PaginadoConTotales<Factura, TotalesFacturas>> {
    await this.rolEnUnidad(user, query.inmuebleId);
    const liberadas = await this.envios
      .find({
        copropiedadId: new Types.ObjectId(user.copropiedadId!),
        inmuebleId: new Types.ObjectId(query.inmuebleId),
        liberadaEn: { $ne: null },
      })
      .select('facturaId')
      .limit(MAX_LIBERADAS_POR_UNIDAD)
      .lean()
      .exec();
    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;
    if (liberadas.length === 0) {
      return { items: [], total: 0, pagina, porPagina };
    }
    return this.facturas.findAll(
      {
        inmuebleId: query.inmuebleId,
        pagina: query.pagina,
        porPagina: query.porPagina,
      },
      { soloIds: liberadas.map((e) => e.facturaId) },
    );
  }

  /** The invoice's own PDF page, if its unit is one the caller holds. */
  async documentoPdfDeFactura(
    user: IRequestUser,
    facturaId: string,
  ): Promise<Uint8Array> {
    if (!Types.ObjectId.isValid(facturaId)) throw this.noEncontrado();
    // Tenant-scoped read: an invoice of another coproperty is simply absent.
    const factura = await this.facturas.findOneRaw(facturaId);
    await this.rolEnUnidad(user, String(factura.inmuebleId));
    // Not released yet = not there, exactly like an invoice of another unit.
    const liberada = await this.envios
      .exists({
        copropiedadId: new Types.ObjectId(user.copropiedadId!),
        facturaId: new Types.ObjectId(facturaId),
        liberadaEn: { $ne: null },
      })
      .exec();
    if (!liberada) throw this.noEncontrado();
    return paginaIndividualDeFactura(
      facturaId,
      factura,
      this.presentacionDocumento,
      this.storage,
    );
  }

  /**
   * Statement of account of a unit. Owners only: it shows the accumulated
   * balance of the owner, which a tenant does not see.
   */
  async estadoCuentaDe(
    user: IRequestUser,
    query: EstadoCuentaPortalDto,
  ): ReturnType<EstadoCuentaService['findAll']> {
    const rol = await this.rolEnUnidad(user, query.inmuebleId);
    if (rol !== 'propietario') {
      throw new ForbiddenException(
        'El estado de cuenta solo está disponible para el propietario',
      );
    }
    return this.estadoCuenta.findAll({
      inmuebleId: query.inmuebleId,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
    });
  }

  private async rolEnUnidad(
    user: IRequestUser,
    inmuebleId: string,
  ): Promise<RolPortal> {
    const rol = await this.acceso.rolEn(
      user.accountId!,
      user.copropiedadId!,
      inmuebleId,
    );
    if (!rol) throw this.noEncontrado();
    return rol;
  }

  private noEncontrado(): NotFoundException {
    return new NotFoundException('No se encontró lo que buscás');
  }
}
