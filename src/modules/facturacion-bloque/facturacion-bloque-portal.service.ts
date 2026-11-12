// src/modules/facturacion-bloque/facturacion-bloque-portal.service.ts
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { DescargaArchivo, MiDocumentoBloque } from '../../contracts';
import {
  BloqueFacturacion,
  type BloqueFacturacionDocument,
  type EstadoBloque,
} from '../../database/schemas/administracion/bloque-facturacion.schema';
import {
  DocumentoBloque,
  type DocumentoBloqueDocument,
} from '../../database/schemas/administracion/documento-bloque.schema';
import {
  cuentaParaAccesoDe,
  PortalAccesoService,
} from '../portal/portal-acceso.service';
import { puedeVerTipo, TIPOS_DE_RESIDENTE } from './facturacion-bloque-acceso';
import { FacturacionBloqueAlmacenService } from './facturacion-bloque-almacen.service';
import { toMiDocumento } from './facturacion-bloque.mapper';
import type { ListarMisDocumentosDto } from './dto/listar-bloques.dto';

/**
 * A resident sees a block's documents only once the admin pressed "send".
 * Everything before that (`generado`) is staff-only, and so is a block that
 * failed to process.
 */
const ESTADOS_VISIBLES: EstadoBloque[] = ['pendiente_envio', 'enviado'];

/**
 * READ-ONLY view of the sent documents for residents (owners and tenants).
 *
 * A resident carries no CASL permissions, so authorization is data-level and
 * derived on every request: the units the caller holds in the ACTIVE coproperty
 * (`PortalAccesoService`) with the role on EACH of them decide what they see.
 * Per unit, the owner gets invoices and statements of account, the tenant only
 * invoices, and nobody gets a receipt (`puedeVerTipo`, the same rule that picks
 * the recipients of a send). Anything else — another unit's document, a kind
 * the role may not see, a block not sent yet, a malformed id — is the SAME 404,
 * so nothing about hidden content leaks. There is no write method here and must
 * not be one.
 */
@Injectable()
export class FacturacionBloquePortalService {
  constructor(
    @InjectModel(DocumentoBloque.name)
    private readonly documentos: Model<DocumentoBloqueDocument>,
    @InjectModel(BloqueFacturacion.name)
    private readonly bloques: Model<BloqueFacturacionDocument>,
    private readonly tenant: TenantContextService,
    private readonly portalAcceso: PortalAccesoService,
    private readonly almacen: FacturacionBloqueAlmacenService,
  ) {}

  private cuenta(user: IRequestUser): string {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException('No se pudo identificar tu cuenta');
    }
    return user.accountId;
  }

  /** The documents of the caller's units, newest sent first. */
  async listar(
    filtros: ListarMisDocumentosDto,
    user: IRequestUser,
  ): Promise<MiDocumentoBloque[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const unidades = await this.portalAcceso.unidadesDe(
      this.cuenta(user),
      copropiedadId.toString(),
      cuentaParaAccesoDe(user),
    );
    if (unidades.length === 0) return [];
    const rolPorUnidad = new Map(unidades.map((u) => [u.inmuebleId, u.rol]));

    const candidatos = await this.documentos
      .find({
        copropiedadId,
        inmuebleId: {
          $in: unidades.map((u) => new Types.ObjectId(u.inmuebleId)),
        },
        tipo: { $in: filtros.tipo ? [filtros.tipo] : [...TIPOS_DE_RESIDENTE] },
      })
      .exec();
    const permitidos = candidatos.filter((d) => {
      const rol = rolPorUnidad.get(d.inmuebleId.toString());
      return rol !== undefined && puedeVerTipo(rol, d.tipo);
    });
    if (permitidos.length === 0) return [];

    const enviados = await this.bloques
      .find({
        _id: {
          $in: [...new Set(permitidos.map((d) => d.bloqueId.toString()))],
        },
        copropiedadId,
        estado: { $in: ESTADOS_VISIBLES },
      })
      .select('enviadoEn createdAt')
      .exec();
    const fechaPorBloque = new Map(
      enviados.map((b) => [b._id.toString(), b.enviadoEn ?? b.createdAt]),
    );

    return permitidos
      .filter((d) => fechaPorBloque.has(d.bloqueId.toString()))
      .map((d) => ({
        doc: d,
        fecha: fechaPorBloque.get(d.bloqueId.toString()) as Date,
      }))
      .sort((a, b) => b.fecha.getTime() - a.fecha.getTime())
      .map(({ doc, fecha }) =>
        toMiDocumento(
          doc,
          rolPorUnidad.get(doc.inmuebleId.toString()) ?? 'propietario',
          fecha,
        ),
      );
  }

  /** Signs a short-lived read URL for one of the caller's own documents. */
  async descargar(id: string, user: IRequestUser): Promise<DescargaArchivo> {
    const noEncontrado = () =>
      new NotFoundException(`Documento ${id} no encontrado`);
    const cuenta = this.cuenta(user);
    if (!Types.ObjectId.isValid(id)) throw noEncontrado();
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const documento = await this.documentos
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!documento) throw noEncontrado();

    const rol = await this.portalAcceso.rolEn(
      cuenta,
      copropiedadId.toString(),
      documento.inmuebleId.toString(),
      cuentaParaAccesoDe(user),
    );
    if (!rol || !puedeVerTipo(rol, documento.tipo)) throw noEncontrado();

    const enviado = await this.bloques
      .exists({
        _id: documento.bloqueId,
        copropiedadId,
        estado: { $in: ESTADOS_VISIBLES },
      })
      .exec();
    if (!enviado) throw noEncontrado();

    const nombre =
      `${documento.tipo}-${documento.periodo}-${documento.codigoInmueble}.pdf`.replace(
        /[^\w.-]+/g,
        '_',
      );
    const url = await this.almacen.firmarLectura(
      documento.rutaAlmacenamiento,
      nombre,
    );
    return { url, nombre };
  }
}
