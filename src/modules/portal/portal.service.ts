// src/modules/portal/portal.service.ts
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
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
  ) {}

  /** The caller's own units and their role on each. */
  unidades(user: IRequestUser): Promise<UnidadPortal[]> {
    return this.acceso.unidadesDe(user.accountId!, user.copropiedadId!);
  }

  /** Invoices of one unit the caller holds (owner or tenant). */
  async facturasDe(
    user: IRequestUser,
    query: ListarFacturasPortalDto,
  ): Promise<PaginadoConTotales<Factura, TotalesFacturas>> {
    await this.rolEnUnidad(user, query.inmuebleId);
    return this.facturas.findAll({
      inmuebleId: query.inmuebleId,
      pagina: query.pagina,
      porPagina: query.porPagina,
    });
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
