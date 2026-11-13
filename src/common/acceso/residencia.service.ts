// src/common/acceso/residencia.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  RevocacionPortal,
  RevocacionPortalDocument,
} from '../../database/schemas/cuentas/revocacion-portal.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { modulosEfectivos } from '../licencia/modulos';
import { normalizarEmail } from '../utils/email.utils';
import {
  coincideCorreo,
  copropiedadAdmiteIngresoResidentes,
  motivoCorreoGenerico,
  revocacionAplica,
  type MotivoCorreoGenerico,
} from './residencia.reglas';

/** A holder record that carries an address, ids as strings. */
export interface TerceroDeCorreo {
  id: string;
  copropiedadId: string;
}

/**
 * The query side of address-derived resident access: which parties carry an
 * address, in which coproperties they currently hold a unit, and which
 * coproperties revoked the address. It only reads; `reglas` decide and the
 * callers (`AccesoService`, `PortalAccesoService`) combine.
 *
 * Nothing is cached: removing the address from a record, a sale, or a
 * revocation must take effect on the next request. Every query that follows a
 * matched record names that record's own `copropiedadId` or `_id`, so a party
 * of one coproperty can never grant anything in another.
 */
@Injectable()
export class ResidenciaService {
  constructor(
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(RevocacionPortal.name)
    private readonly revocaciones: Model<RevocacionPortalDocument>,
  ) {}

  /**
   * The ACTIVE parties whose `emails` carry the address, for address-derived
   * residency. The `emails_ci` collation index finds candidates
   * case-insensitively; each one is then rechecked in memory (`coincideCorreo`),
   * which drops a collation false positive and a legacy padded value. Without
   * the index the query is a collection scan, never a wrong answer.
   *
   * A generic inbox (`motivoCorreoGenerico`: an address on more than
   * `MAX_TERCEROS_POR_CORREO` parties) answers NOTHING, so every
   * caller that derives residency from an address (`copropiedadesPorCorreo`,
   * `PortalAccesoService`, the sign-in request and redeem) refuses it alike.
   */
  async tercerosPorCorreo(correo: string): Promise<TerceroDeCorreo[]> {
    const normalizado = normalizarEmail(correo);
    if (normalizado.length === 0) return [];

    const partes = await this.partesConCorreo([normalizado]);
    const propias = partes.get(normalizado) ?? [];
    if (propias.length === 0) return [];

    const motivo = motivoCorreoGenerico({ tercerosDistintos: propias.length });
    return motivo === null ? propias : [];
  }

  /**
   * Of these addresses, the generic inboxes and why (keys normalized): the
   * batch form of the rule `tercerosPorCorreo` applies, for callers that judge
   * many addresses at once (`DirectorioService`, the Residentes listing's
   * `requiereCorreccion`). One query however many addresses.
   */
  async motivosCorreoGenerico(
    correos: readonly string[],
  ): Promise<Map<string, MotivoCorreoGenerico>> {
    const resultado = new Map<string, MotivoCorreoGenerico>();
    const normalizados = [
      ...new Set(correos.map((c) => normalizarEmail(c))),
    ].filter((c) => c.length > 0);
    if (normalizados.length === 0) return resultado;

    const partes = await this.partesConCorreo(normalizados);
    for (const correo of normalizados) {
      const motivo = motivoCorreoGenerico({
        tercerosDistintos: partes.get(correo)?.length ?? 0,
      });
      if (motivo !== null) resultado.set(correo, motivo);
    }
    return resultado;
  }

  /**
   * The distinct ACTIVE parties carrying each (normalized) address, across all
   * coproperties, rechecked with `coincideCorreo`. One query.
   */
  private async partesConCorreo(
    normalizados: readonly string[],
  ): Promise<Map<string, TerceroDeCorreo[]>> {
    const candidatos = await this.terceros
      .find({
        emails:
          normalizados.length === 1
            ? normalizados[0]
            : { $in: [...normalizados] },
        estado: 'active',
      })
      .collation({ locale: 'en', strength: 2 })
      .select('_id copropiedadId emails')
      .lean()
      .exec();

    const resultado = new Map<string, TerceroDeCorreo[]>();
    for (const correo of normalizados) {
      const vistos = new Set<string>();
      const lista: TerceroDeCorreo[] = [];
      for (const t of candidatos) {
        const id = t._id.toString();
        if (vistos.has(id)) continue;
        if ((t.emails ?? []).some((e) => coincideCorreo(e, correo))) {
          vistos.add(id);
          lista.push({ id, copropiedadId: t.copropiedadId.toString() });
        }
      }
      resultado.set(correo, lista);
    }
    return resultado;
  }

  /**
   * Coproperties where the address CURRENTLY reaches a unit, each with the
   * parties of that address that hold it: an active unit, of an active
   * coproperty that contracted a module, whose titular or arrendatario is a
   * party of that SAME coproperty carrying the address. A unit pointing at a
   * party of another coproperty grants nothing. Revocations are not applied
   * here (`revocacionesActivas`).
   */
  async copropiedadesPorCorreo(correo: string): Promise<Map<string, string[]>> {
    const partes = await this.tercerosPorCorreo(correo);
    const resultado = new Map<string, string[]>();
    if (partes.length === 0) return resultado;

    const porCopropiedad = new Map<string, TerceroDeCorreo[]>();
    for (const parte of partes) {
      const lista = porCopropiedad.get(parte.copropiedadId) ?? [];
      lista.push(parte);
      porCopropiedad.set(parte.copropiedadId, lista);
    }

    // One branch per coproperty, each naming it explicitly.
    const unidades = await this.inmuebles
      .find({
        estado: 'active',
        $or: [...porCopropiedad.entries()].map(([copropiedadId, lista]) => {
          const ids = lista.map((p) => new Types.ObjectId(p.id));
          return {
            copropiedadId: new Types.ObjectId(copropiedadId),
            $or: [
              { titularId: { $in: ids } },
              { arrendatarioId: { $in: ids } },
            ],
          };
        }),
      })
      .select('copropiedadId titularId arrendatarioId')
      .lean()
      .exec();

    const sosteniendo = new Map<string, Set<string>>();
    for (const unidad of unidades) {
      const copropiedadId = unidad.copropiedadId.toString();
      const propias = new Set(
        (porCopropiedad.get(copropiedadId) ?? []).map((p) => p.id),
      );
      for (const lado of [unidad.titularId, unidad.arrendatarioId]) {
        // The party must belong to the unit's own coproperty.
        if (lado && propias.has(lado.toString())) {
          const conjunto = sosteniendo.get(copropiedadId) ?? new Set<string>();
          conjunto.add(lado.toString());
          sosteniendo.set(copropiedadId, conjunto);
        }
      }
    }
    if (sosteniendo.size === 0) return resultado;

    const vigentes = await this.copropiedades
      .find({
        _id: {
          $in: [...sosteniendo.keys()].map((id) => new Types.ObjectId(id)),
        },
        estado: 'active',
      })
      .select('_id modulosContratados')
      .lean()
      .exec();

    for (const copropiedad of vigentes) {
      const id = copropiedad._id.toString();
      if (!copropiedadAdmiteIngresoResidentes(modulosEfectivos(copropiedad))) {
        continue;
      }
      resultado.set(id, [...(sosteniendo.get(id) ?? [])]);
    }
    return resultado;
  }

  /**
   * Of these addresses (`clave`), the ones with an active revocation in ONE
   * coproperty: the batch form of `revocacionesActivas` for callers that judge
   * many accounts at once (the notice audiences). Same rule, one query.
   */
  async clavesRevocadas(
    claves: readonly string[],
    copropiedadId: string,
  ): Promise<Set<string>> {
    const revocadas = new Set<string>();
    if (claves.length === 0) return revocadas;

    const filas = await this.revocaciones
      .find({ clave: { $in: [...claves] }, activa: true })
      .select('clave copropiedadId activa')
      .lean()
      .exec();
    for (const fila of filas) {
      const revocacion = {
        copropiedadId: fila.copropiedadId.toString(),
        activa: fila.activa,
      };
      if (revocacionAplica(revocacion, copropiedadId)) {
        revocadas.add(fila.clave);
      }
    }
    return revocadas;
  }

  /**
   * Which of `copropiedadIds` have an active revocation for the address
   * (`clave`). Reads by `{clave, activa}` and lets the one rule
   * (`revocacionAplica`) decide per coproperty, so flipping the revocation
   * scope is a change in `residencia.reglas.ts` and nowhere else. Lifted rows
   * are history and never apply.
   */
  async revocacionesActivas(
    clave: string,
    copropiedadIds: readonly string[],
  ): Promise<Set<string>> {
    const revocadas = new Set<string>();
    if (copropiedadIds.length === 0) return revocadas;

    const filas = await this.revocaciones
      .find({ clave, activa: true })
      .select('copropiedadId activa')
      .lean()
      .exec();
    const revocaciones = filas.map((r) => ({
      copropiedadId: r.copropiedadId.toString(),
      activa: r.activa,
    }));

    for (const id of copropiedadIds) {
      if (revocaciones.some((r) => revocacionAplica(r, id))) revocadas.add(id);
    }
    return revocadas;
  }
}
