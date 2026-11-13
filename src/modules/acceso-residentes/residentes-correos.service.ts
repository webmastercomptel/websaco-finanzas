// src/modules/acceso-residentes/residentes-correos.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { claveCorreo, normalizarEmail } from '../../common/utils/email.utils';
import type {
  Paginado,
  ResidenteCorreo,
  UnidadDeResidente,
} from '../../contracts';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Account,
  type AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Tercero,
  type TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import type { ListarResidentesCorreosDto } from './dto/listar-residentes-correos.dto';
import {
  construirFilasResidentes,
  direccionesDeTercero,
  filtrarFilasResidentes,
  paginarFilas,
  type CuentaParaFila,
  type TerceroParaFila,
} from './residentes-correos.mapper';

/**
 * Residentes, per ADDRESS: who can enter the portal of the active coproperty,
 * and the staff operations on it (resend the sign-in link, revoke, re-allow).
 * Granting is not here: anyone with an address on a record enters by
 * themselves (`modules/ingreso-portal/`).
 *
 * Every read names the ACTIVE coproperty (`resolveCoPropertyId()`, never the
 * payload). The address is shown to staff only, and no log line of this
 * service carries one.
 */
@Injectable()
export class ResidentesCorreosService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    private readonly tenant: TenantContextService,
    private readonly residencia: ResidenciaService,
  ) {}

  /**
   * Units of the active coproperty that have a holder, keyed by the holder's
   * party id. One query however many units: the coproperty is bounded
   * (hundreds of units) and the list needs the whole map.
   */
  private async unidadesPorTercero(
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, UnidadDeResidente[]>> {
    const unidades = await this.inmuebles
      .find({
        copropiedadId,
        estado: 'active',
        $or: [{ titularId: { $ne: null } }, { arrendatarioId: { $ne: null } }],
      })
      .select('codigo titularId arrendatarioId')
      .sort({ codigo: 1 })
      .lean()
      .exec();

    const mapa = new Map<string, UnidadDeResidente[]>();
    const agregar = (
      terceroId: Types.ObjectId | null | undefined,
      u: { _id: Types.ObjectId; codigo: string },
      rol: UnidadDeResidente['rol'],
    ): void => {
      if (!terceroId) return;
      const clave = terceroId.toString();
      const lista = mapa.get(clave) ?? [];
      lista.push({ inmuebleId: u._id.toString(), codigo: u.codigo, rol });
      mapa.set(clave, lista);
    };
    for (const u of unidades) {
      agregar(u.titularId, u, 'propietario');
      agregar(u.arrendatarioId, u, 'arrendatario');
    }
    return mapa;
  }

  /**
   * One row per (party, address) of the current owners and tenants of the
   * active coproperty. The rows are built in memory from ONE query each for
   * units, parties, accounts and revocations (plus one for the generic-inbox
   * rule), so the cost does not grow with the number of parties. A party that
   * holds no unit, or has no usable address, has no row.
   */
  async listar(
    filtros: ListarResidentesCorreosDto,
  ): Promise<Paginado<ResidenteCorreo>> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pagina = filtros.pagina ?? 1;
    const porPagina = filtros.porPagina ?? 50;

    const unidades = await this.unidadesPorTercero(copropiedadId);
    if (unidades.size === 0) return paginarFilas([], pagina, porPagina);

    const filas = await this.terceros
      .find({
        _id: { $in: [...unidades.keys()].map((id) => new Types.ObjectId(id)) },
        copropiedadId,
        estado: 'active',
      })
      .select('nombre emails accountId')
      .sort({ nombre: 1, _id: 1 })
      .lean()
      .exec();
    const terceros: TerceroParaFila[] = filas.map((t) => ({
      id: t._id.toString(),
      nombre: t.nombre,
      emails: t.emails ?? [],
      accountId: t.accountId ? t.accountId.toString() : null,
    }));

    const correos = new Set<string>();
    for (const t of terceros) {
      for (const d of direccionesDeTercero(t.emails)) {
        correos.add(normalizarEmail(d.correo));
      }
    }
    const cuentaIds = terceros
      .map((t) => t.accountId)
      .filter((id): id is string => id !== null);

    const ramas: Record<string, unknown>[] = [];
    if (correos.size > 0) ramas.push({ email: { $in: [...correos] } });
    if (cuentaIds.length > 0) {
      ramas.push({
        _id: { $in: cuentaIds.map((id) => new Types.ObjectId(id)) },
      });
    }
    const cuentasDocs =
      ramas.length === 0
        ? []
        : await this.cuentas
            .find({ $or: ramas })
            .select('email correoProbadoClave ultimoIngresoPortalEn')
            .lean()
            .exec();
    const cuentas: CuentaParaFila[] = cuentasDocs.map((c) => ({
      id: c._id.toString(),
      email: c.email,
      correoProbadoClave: c.correoProbadoClave ?? null,
      ultimoIngresoPortalEn: c.ultimoIngresoPortalEn ?? null,
    }));

    // An orphaned legacy account (its address left the record) is judged too.
    const claves = new Set<string>([...correos].map((c) => claveCorreo(c)));
    for (const c of cuentas) claves.add(claveCorreo(c.email));

    const [revocadas, genericos] = await Promise.all([
      this.residencia.clavesRevocadas([...claves], copropiedadId.toString()),
      this.residencia.motivosCorreoGenerico([...correos]),
    ]);

    const todas = construirFilasResidentes({
      terceros,
      unidades,
      cuentasPorId: new Map(cuentas.map((c) => [c.id, c])),
      cuentasPorCorreo: new Map(
        cuentas.map((c) => [normalizarEmail(c.email), c]),
      ),
      revocadas,
      genericos,
    });
    return paginarFilas(
      filtrarFilasResidentes(todas, {
        buscar: filtros.buscar,
        estado: filtros.estado,
      }),
      pagina,
      porPagina,
    );
  }
}
