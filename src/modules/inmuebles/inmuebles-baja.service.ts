// src/modules/inmuebles/inmuebles-baja.service.ts
import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import type { ResultadoDarDeBajaInmuebles } from '../../contracts';
import type { DarDeBajaInmueblesDto } from './dto/dar-de-baja-inmuebles.dto';

/** Who is asking, for the audit entry. */
export interface ActorBaja {
  accountId: string;
  nombre: string;
}

/** How many retired codes the audit label spells out; the rest is a count. */
const MAX_CODIGOS_EN_AUDITORIA = 50;

/**
 * The explicit, separate act of retiring units — what a roster import never
 * does on its own. A file that leaves a unit out only REPORTS it as absent
 * (see the import preview); the person then confirms, and this runs.
 *
 * LOGICAL retirement only: `estado` goes from `active` to `inactive` and
 * nothing is ever deleted. That is why there is no invoice guard here, unlike
 * `InmueblesEliminacionService`: retiring an invoiced unit orphans nothing,
 * every past Factura/Recibo/saldo stays exactly as it was. The only effect is
 * forward-looking — `LotesFacturacionService` queries `estado: 'active'` when
 * it liquidates, so a retired unit drops out of future cycles. It is also
 * reversible: editing the unit with `estado: 'activo'` brings it back.
 *
 * Kept as its own service so `InmueblesService`'s constructor does not grow an
 * audit dependency it otherwise has no use for.
 */
@Injectable()
export class InmueblesBajaService {
  constructor(
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly auditoria: AuditoriaService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Retires the units named by `dto.codigos` in the active coproperty.
   *
   * Codes are matched trimmed and case-insensitive — the same semantics as
   * `InmueblesService.filtroCodigoDuplicado` — against the coproperty's units
   * loaded ONCE with `copropiedadId` in the filter, so a code that only exists
   * in ANOTHER coproperty is simply `noEncontrados` and never touched. The
   * same code repeated in the request counts once. A code can match SEVERAL
   * legacy units that differ only by case (the preview treats them as one
   * code too): every active one is retired, every inactive one is reported in
   * `yaInactivos`.
   *
   * The `updateMany` (by the found ids, `copropiedadId` AND `estado: 'active'`)
   * and the ONE audit entry for the request run in the SAME transaction, so
   * they commit or roll back together: an audit failure leaves every unit
   * active, and a successful retirement can never lack its entry (the audit
   * law). That is also what makes a retry safe — after a failure nothing
   * changed, so repeating the call retires them for real instead of answering
   * `yaInactivos` and losing the entry. `dadosDeBaja` and the audit count come
   * from `modifiedCount`, so two concurrent calls over the same units never
   * report the same unit twice (the codes listed in the label are the ones this
   * call found active, which can include one a concurrent call retired first).
   * A request that retires nothing writes no entry.
   */
  async darDeBaja(
    dto: DarDeBajaInmueblesDto,
    actor: ActorBaja,
  ): Promise<ResultadoDarDeBajaInmuebles> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // Distinct by comparison key, keeping the first spelling for the answer.
    const solicitados = new Map<string, string>();
    for (const codigo of dto.codigos) {
      const clave = codigo.trim().toLowerCase();
      if (!solicitados.has(clave)) solicitados.set(clave, codigo.trim());
    }

    const unidades = await this.inmuebles
      .find({ copropiedadId })
      .select('_id codigo estado')
      .lean()
      .exec();
    type Leida = (typeof unidades)[number];
    const porClave = new Map<string, Leida[]>();
    for (const u of unidades) {
      const clave = u.codigo.trim().toLowerCase();
      porClave.set(clave, [...(porClave.get(clave) ?? []), u]);
    }

    const aDarDeBaja: Leida[] = [];
    const yaInactivos: string[] = [];
    const noEncontrados: string[] = [];
    for (const [clave, codigo] of solicitados) {
      const coincidentes = porClave.get(clave);
      if (!coincidentes) {
        noEncontrados.push(codigo);
        continue;
      }
      for (const unidad of coincidentes) {
        if (unidad.estado === 'active') aDarDeBaja.push(unidad);
        else yaInactivos.push(unidad.codigo);
      }
    }

    let dadosDeBaja = 0;
    if (aDarDeBaja.length > 0) {
      const etiquetaCopropiedad =
        await this.etiquetaDeCopropiedad(copropiedadId);
      dadosDeBaja = await this.transaccion(async (session) => {
        const { modifiedCount } = await this.inmuebles
          .updateMany(
            {
              _id: { $in: aDarDeBaja.map((u) => u._id) },
              copropiedadId,
              estado: 'active',
            },
            { $set: { estado: 'inactive' } },
            { session },
          )
          .exec();
        if (modifiedCount > 0) {
          await this.registrarAuditoria(
            actor,
            etiquetaCopropiedad,
            modifiedCount,
            aDarDeBaja.map((u) => u.codigo),
            aDarDeBaja[0]._id.toString(),
            session,
          );
        }
        return modifiedCount;
      });
    }

    return {
      solicitados: solicitados.size,
      dadosDeBaja,
      yaInactivos,
      noEncontrados,
    };
  }

  /** Same shape as the other transactional services: `withTransaction` may
   *  re-run the callback on a transient error, so it must be safe to repeat
   *  (the `estado: 'active'` filter makes the update so). */
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

  /** "0001 Torres del Sol", read before the transaction to keep it short. */
  private async etiquetaDeCopropiedad(
    copropiedadId: Types.ObjectId,
  ): Promise<string> {
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('codigo nombre')
      .lean()
      .exec();
    return (
      [copropiedad?.codigo, copropiedad?.nombre].filter(Boolean).join(' ') ||
      copropiedadId.toString()
    );
  }

  /**
   * One entry per request, written inside the retirement's transaction.
   * `EntradaAuditoria` has no payload field, so the count and (up to 50) codes
   * travel in the label, as the cycle reset does with its counts. `entidadId`
   * is the first retired unit: the entry is about a batch and the schema wants
   * one id, and a unit id keeps it traceable to a real record.
   */
  private async registrarAuditoria(
    actor: ActorBaja,
    donde: string,
    cantidad: number,
    codigos: string[],
    entidadId: string,
    session: ClientSession,
  ): Promise<void> {
    const listados = codigos.slice(0, MAX_CODIGOS_EN_AUDITORIA).join(', ');
    const resto =
      codigos.length > MAX_CODIGOS_EN_AUDITORIA
        ? ` y ${codigos.length - MAX_CODIGOS_EN_AUDITORIA} más`
        : '';

    await this.auditoria.registrar(
      {
        actorAccountId: actor.accountId,
        actorNombre: actor.nombre,
        accion: 'dar-de-baja',
        entidadTipo: 'inmueble',
        entidadId,
        entidadEtiqueta: `${cantidad} inmueble(s) dados de baja en ${donde}: ${listados}${resto}`,
      },
      session,
    );
  }
}
