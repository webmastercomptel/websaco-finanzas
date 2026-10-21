// src/modules/inmuebles/inmuebles-baja.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
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
  ) {}

  /**
   * Retires the units named by `dto.codigos` in the active coproperty.
   *
   * Codes are matched trimmed and case-insensitive — the same semantics as
   * `InmueblesService.filtroCodigoDuplicado` — against the coproperty's units
   * loaded ONCE with `copropiedadId` in the filter, so a code that only exists
   * in ANOTHER coproperty is simply `noEncontrados` and never touched. The
   * same code repeated in the request counts once.
   *
   * One `updateMany` over the found ids AND `copropiedadId` does the retiring.
   * Then ONE audit entry for the whole request (the audit law: a state change
   * leaves a trace of who and when). The audit is written after the update
   * and a failure to write it rejects the request, as `AuditoriaService`
   * documents; the retirement is idempotent, so repeating the call just
   * answers `yaInactivos`. A request that retires nothing writes no entry.
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
    const porClave = new Map<string, (typeof unidades)[number]>();
    for (const u of unidades) {
      const clave = u.codigo.trim().toLowerCase();
      if (!porClave.has(clave)) porClave.set(clave, u);
    }

    const aDarDeBaja: (typeof unidades)[number][] = [];
    const yaInactivos: string[] = [];
    const noEncontrados: string[] = [];
    for (const [clave, codigo] of solicitados) {
      const unidad = porClave.get(clave);
      if (!unidad) noEncontrados.push(codigo);
      else if (unidad.estado === 'active') aDarDeBaja.push(unidad);
      else yaInactivos.push(unidad.codigo);
    }

    if (aDarDeBaja.length > 0) {
      await this.inmuebles
        .updateMany(
          { _id: { $in: aDarDeBaja.map((u) => u._id) }, copropiedadId },
          { $set: { estado: 'inactive' } },
        )
        .exec();
      await this.registrarAuditoria(
        actor,
        copropiedadId,
        aDarDeBaja.map((u) => u.codigo),
        aDarDeBaja[0]._id.toString(),
      );
    }

    return {
      solicitados: solicitados.size,
      dadosDeBaja: aDarDeBaja.length,
      yaInactivos,
      noEncontrados,
    };
  }

  /**
   * One entry per request. `EntradaAuditoria` has no payload field, so the
   * count and (up to 50) codes travel in the label, as the cycle reset does
   * with its counts. `entidadId` is the first retired unit: the entry is about
   * a batch and the schema wants one id, and a unit id keeps it traceable to
   * a real record.
   */
  private async registrarAuditoria(
    actor: ActorBaja,
    copropiedadId: Types.ObjectId,
    codigos: string[],
    entidadId: string,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('codigo nombre')
      .lean()
      .exec();
    const donde =
      [copropiedad?.codigo, copropiedad?.nombre].filter(Boolean).join(' ') ||
      copropiedadId.toString();
    const listados = codigos.slice(0, MAX_CODIGOS_EN_AUDITORIA).join(', ');
    const resto =
      codigos.length > MAX_CODIGOS_EN_AUDITORIA
        ? ` y ${codigos.length - MAX_CODIGOS_EN_AUDITORIA} más`
        : '';

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'dar-de-baja',
      entidadTipo: 'inmueble',
      entidadId,
      entidadEtiqueta: `${codigos.length} inmueble(s) dados de baja en ${donde}: ${listados}${resto}`,
    });
  }
}
