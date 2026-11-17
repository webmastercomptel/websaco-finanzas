// src/modules/organos/organos.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { correosValidos } from '../../common/directorio/destinos-correo';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import {
  ETIQUETA_ORGANO,
  IntegranteOrgano as IntegranteOrganoModelo,
  type IntegranteOrganoDocument,
  type OrganoCopropiedad,
} from '../../database/schemas/administracion/integrante-organo.schema';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  type TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import type {
  CandidatoOrgano,
  IntegranteOrgano,
  OrganosCopropiedad,
  UnidadDeIntegrante,
} from '../../contracts';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { correosDeIntegrantes, unidadesPorTercero } from './organos.reglas';

/** Mongo's duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

const MAX_CANDIDATOS = 20;

const SIN_PERSONA = 'Persona no encontrada';

const MENSAJE_NO_CALIFICA =
  'Esa persona no es propietaria ni arrendataria de un inmueble activo de esta copropiedad.';

interface MiembroLeido {
  id: string;
  organo: OrganoCopropiedad;
  terceroId: string;
  nombre: string;
  emails: string[];
  unidades: UnidadDeIntegrante[];
  vigente: boolean;
}

/**
 * Member lists of the Consejo de Administración and the Comité de Convivencia
 * of the ACTIVE coproperty. Only the link party-body is stored; name, e-mails
 * and units are read live, and a member whose party lost every active unit is
 * kept but not `vigente` (so it receives nothing) instead of being deleted
 * behind the administrator's back. Every query carries the coproperty as an
 * `ObjectId`; a write and its audit entry share one transaction.
 */
@Injectable()
export class OrganosService {
  constructor(
    @InjectModel(IntegranteOrganoModelo.name)
    private readonly integrantes: Model<IntegranteOrganoDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
    private readonly auditoria: AuditoriaService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** Same pattern as `RolesService`: the callback must be safe to re-run. */
  private async transaccion<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let resultado!: T;
      await session.withTransaction(async () => {
        resultado = await fn(session);
      });
      return resultado;
    } finally {
      await session.endSession();
    }
  }

  /** Active units of the coproperty tied to any of the given parties. */
  private async unidadesDe(
    copropiedadId: Types.ObjectId,
    ids: Types.ObjectId[],
  ): Promise<Map<string, UnidadDeIntegrante[]>> {
    if (ids.length === 0) return new Map();
    const inmuebles = await this.inmuebles
      .find({
        copropiedadId,
        estado: 'active',
        $or: [{ titularId: { $in: ids } }, { arrendatarioId: { $in: ids } }],
      })
      .select('codigo titularId arrendatarioId')
      .lean()
      .exec();
    return unidadesPorTercero(inmuebles);
  }

  /** Resolves the party and units of stored members (two queries at most). */
  private async leer(
    copropiedadId: Types.ObjectId,
    filas: {
      _id: Types.ObjectId;
      organo: OrganoCopropiedad;
      terceroId: Types.ObjectId;
    }[],
  ): Promise<MiembroLeido[]> {
    if (filas.length === 0) return [];
    const ids = filas.map((f) => f.terceroId);
    const unidades = await this.unidadesDe(copropiedadId, ids);
    const partes = await this.terceros
      .find({ copropiedadId, _id: { $in: ids } })
      .select('nombre emails estado')
      .lean()
      .exec();
    const porId = new Map(partes.map((p) => [p._id.toString(), p]));
    return filas
      .map((fila) => {
        const parte = porId.get(fila.terceroId.toString());
        const susUnidades = unidades.get(fila.terceroId.toString()) ?? [];
        return {
          id: fila._id.toString(),
          organo: fila.organo,
          terceroId: fila.terceroId.toString(),
          nombre: parte?.nombre ?? SIN_PERSONA,
          emails: parte?.emails ?? [],
          unidades: susUnidades,
          vigente:
            !!parte && parte.estado === 'active' && susUnidades.length > 0,
        };
      })
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  private aContrato(m: MiembroLeido): IntegranteOrgano {
    return {
      id: m.id,
      organo: m.organo,
      terceroId: m.terceroId,
      nombre: m.nombre,
      correos: correosValidos(m.emails).map((c) => c.email),
      unidades: m.unidades,
      vigente: m.vigente,
    };
  }

  /** Members of both bodies of the active coproperty, each ordered by name. */
  async listar(): Promise<OrganosCopropiedad> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filas = await this.integrantes.find({ copropiedadId }).lean().exec();
    const leidos = (await this.leer(copropiedadId, filas)).map((m) =>
      this.aContrato(m),
    );
    return {
      consejo: leidos.filter((m) => m.organo === 'consejo'),
      comiteConvivencia: leidos.filter(
        (m) => m.organo === 'comite_convivencia',
      ),
    };
  }

  /** Owners and tenants of an active unit who can be seated, at most 20. */
  async candidatos(q?: string): Promise<CandidatoOrgano[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const inmuebles = await this.inmuebles
      .find({
        copropiedadId,
        estado: 'active',
        $or: [{ titularId: { $ne: null } }, { arrendatarioId: { $ne: null } }],
      })
      .select('codigo titularId arrendatarioId')
      .lean()
      .exec();
    const unidades = unidadesPorTercero(inmuebles);
    const todos = [...unidades.keys()].map((id) => new Types.ObjectId(id));
    if (todos.length === 0) return [];

    const filtro: Record<string, unknown> = {
      copropiedadId,
      estado: 'active',
      _id: { $in: todos },
    };
    const texto = q?.trim();
    if (texto) {
      const minusculas = texto.toLowerCase();
      const porCodigo = [...unidades.entries()]
        .filter(([, lista]) =>
          lista.some((u) => u.codigo.toLowerCase().includes(minusculas)),
        )
        .map(([id]) => new Types.ObjectId(id));
      filtro.$or = [
        { nombre: { $regex: escapeRegex(texto), $options: 'i' } },
        { _id: { $in: porCodigo } },
      ];
    }
    const partes = await this.terceros
      .find(filtro)
      .select('nombre emails')
      .sort({ nombre: 1 })
      .limit(MAX_CANDIDATOS)
      .lean()
      .exec();
    return partes.map((p) => ({
      terceroId: p._id.toString(),
      nombre: p.nombre,
      correos: correosValidos(p.emails).map((c) => c.email),
      unidades: unidades.get(p._id.toString()) ?? [],
    }));
  }

  /**
   * Seats a party in a body. A malformed, foreign or non-qualifying party all
   * answer the same 400 so ids of other buildings cannot be probed; the
   * pre-check gives the friendly 409 and the unique index + 11000 mapping
   * covers the concurrent race.
   */
  async agregar(
    organo: OrganoCopropiedad,
    terceroId: string,
    user: IRequestUser,
  ): Promise<IntegranteOrgano> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    if (!Types.ObjectId.isValid(terceroId)) {
      throw new BadRequestException(MENSAJE_NO_CALIFICA);
    }
    const terceroOid = new Types.ObjectId(terceroId);
    const parte = await this.terceros
      .findOne({ _id: terceroOid, copropiedadId, estado: 'active' })
      .select('nombre emails estado')
      .lean()
      .exec();
    const unidades = parte
      ? (await this.unidadesDe(copropiedadId, [terceroOid])).get(
          terceroOid.toString(),
        )
      : undefined;
    if (!parte || !unidades || unidades.length === 0) {
      throw new BadRequestException(MENSAJE_NO_CALIFICA);
    }

    const conflicto = () =>
      new ConflictException(
        `Esa persona ya está en el ${ETIQUETA_ORGANO[organo]}.`,
      );
    const existente = await this.integrantes
      .exists({ copropiedadId, organo, terceroId: terceroOid })
      .exec();
    if (existente) throw conflicto();

    let creado: IntegranteOrganoDocument;
    try {
      creado = await this.transaccion(async (session) => {
        const [nuevo] = await this.integrantes.create(
          [{ copropiedadId, organo, terceroId: terceroOid }],
          { session },
        );
        await this.auditoria.registrar(
          {
            actorAccountId: user.accountId!,
            actorNombre: user.nombre ?? user.email,
            accion: 'crear',
            entidadTipo: 'integrante-organo',
            entidadId: nuevo._id.toString(),
            entidadEtiqueta: `${ETIQUETA_ORGANO[organo]}: ${parte.nombre}`,
          },
          session,
        );
        return nuevo;
      });
    } catch (error) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw conflicto();
      }
      throw error;
    }
    return this.aContrato({
      id: creado._id.toString(),
      organo,
      terceroId: terceroOid.toString(),
      nombre: parte.nombre,
      emails: parte.emails ?? [],
      unidades,
      vigente: true,
    });
  }

  /** Unseats a member. Never touches the party or the unit. */
  async quitar(id: string, user: IRequestUser): Promise<{ id: string }> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const noExiste = () => new NotFoundException('Integrante no encontrado');
    if (!Types.ObjectId.isValid(id)) throw noExiste();
    const oid = new Types.ObjectId(id);
    const fila = await this.integrantes
      .findOne({ _id: oid, copropiedadId })
      .lean()
      .exec();
    if (!fila) throw noExiste();
    const parte = await this.terceros
      .findOne({ _id: fila.terceroId, copropiedadId })
      .select('nombre')
      .lean()
      .exec();

    await this.transaccion(async (session) => {
      const borrado = await this.integrantes
        .findOneAndDelete({ _id: oid, copropiedadId }, { session })
        .exec();
      if (!borrado) throw noExiste();
      await this.auditoria.registrar(
        {
          actorAccountId: user.accountId!,
          actorNombre: user.nombre ?? user.email,
          accion: 'eliminar',
          entidadTipo: 'integrante-organo',
          entidadId: oid.toString(),
          entidadEtiqueta: `${ETIQUETA_ORGANO[fila.organo]}: ${parte?.nombre ?? SIN_PERSONA}`,
        },
        session,
      );
    });
    return { id: oid.toString() };
  }

  /**
   * Addresses of the current members of a body. Takes the coproperty
   * explicitly because the PQR flow calls it outside the member screens.
   * Members that are not `vigente` are skipped; an empty body is `[]`.
   */
  async correosDeOrgano(
    copropiedadId: Types.ObjectId,
    organo: OrganoCopropiedad,
  ): Promise<string[]> {
    const filas = await this.integrantes
      .find({ copropiedadId, organo })
      .lean()
      .exec();
    const leidos = await this.leer(copropiedadId, filas);
    return correosDeIntegrantes(
      leidos.filter((m) => m.vigente).map((m) => ({ emails: m.emails })),
    );
  }
}
