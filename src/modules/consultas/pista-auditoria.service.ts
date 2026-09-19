import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  EventoAuditoria,
  RespuestaPistaAuditoria,
  TipoDocumentoPistaAuditoria,
} from '../../contracts';
import type { ConsultarPistaAuditoriaDto } from './dto/consultar-pista-auditoria.dto';

/** Every document type here declares `{ timestamps: true }` on its
 *  `@Schema()`, so `createdAt` always exists at runtime — but only
 *  `InmuebleDocument` bothers to type it explicitly (see that schema's own
 *  intersection). Every other schema class in this codebase reads it
 *  through this same escape hatch (`notas-credito.mapper.ts`,
 *  `adicion-contabilidad.mapper.ts`, …). */
const createdAtDe = (doc: object): Date =>
  (doc as unknown as { createdAt: Date }).createdAt;

/** A creation or void event before its actor/inmueble ids are resolved to
 *  display names — the intermediate shape the 6 collections are normalized
 *  into before merging. */
interface EventoCrudo {
  fecha: Date;
  accion: 'crear' | 'anular';
  /** `null` only for a Factura whose LoteFacturacion could not be found —
   *  unreachable in practice (a Factura is only ever created FROM its
   *  lote), kept nullable defensively rather than throwing on a report
   *  endpoint. */
  actorId: Types.ObjectId | null;
  tipoDocumento: TipoDocumentoPistaAuditoria;
  numeroCompleto: string;
  inmuebleId: Types.ObjectId;
  valor: number;
  href: string;
}

/**
 * Tenant-scoped, read-only audit trail of who created/voided which
 * financial document, when — merges creation/void EVENTS from the 6
 * operational document types (Factura, Recibo, NotaCredito, NotaDebito,
 * NotaContable, NotaAnticipo) into one feed, filterable by actor, document
 * type, number and date range. `SaldoInicial`/`SaldoInicialAnticipo` are
 * out of scope (one-time opening-balance imports, not recurring
 * operational activity — confirmed excluded by the product owner, see the
 * design spec).
 *
 * One row per EVENT, not per document: a voided document produces both a
 * `'crear'` row (actor = creator, fecha = `createdAt`) and an `'anular'`
 * row (actor = whoever voided it, fecha = `voidedAt`) — collapsing to one
 * row per document would make an actor filter ambiguous (creator? voider?
 * both?).
 *
 * Factura is the one exception to "the actor lives directly on the
 * document": it has no per-Factura creator field, only its
 * `LoteFacturacion.generatedBy` — a Factura is only ever created
 * already-numbered, at the moment its lote is consolidated. `Factura.
 * voidedBy`/`voidedAt` DO live directly on the Factura itself, same as
 * every other type.
 *
 * Same "merge several small per-type queries, sort, slice" shape already
 * used by `VencimientosCarteraService`/`CarteraGeneralService`.
 */
@Injectable()
export class PistaAuditoriaService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(Account.name)
    private readonly accounts: Model<AccountDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    filtros: ConsultarPistaAuditoriaDto,
  ): Promise<RespuestaPistaAuditoria> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const pagina = filtros.pagina ?? 1;
    const porPagina = filtros.porPagina ?? 50;

    // Always query all 6 types regardless of `tipoDocumento` — the
    // `usuarios` distinct-actor list must stay stable across whatever
    // filter is applied to `items`, or the dropdown would shrink every
    // time someone narrowed the report.
    const [
      facturas,
      recibos,
      notasCredito,
      notasDebito,
      notasContables,
      notasAnticipo,
    ] = await Promise.all([
      this.facturas.find({ coPropertyId }).exec(),
      this.recibos.find({ coPropertyId }).exec(),
      this.notasCredito.find({ coPropertyId }).exec(),
      this.notasDebito.find({ coPropertyId }).exec(),
      this.notasContables.find({ coPropertyId }).exec(),
      this.notasAnticipo.find({ coPropertyId }).exec(),
    ]);

    // Factura's own creator lives on its LoteFacturacion — batch-resolve
    // the (usually much smaller) set of lotes involved, one query instead
    // of one per Factura.
    const loteIds = [...new Set(facturas.map((f) => f.loteId.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const lotes = loteIds.length
      ? await this.lotes.find({ coPropertyId, _id: { $in: loteIds } }).exec()
      : [];
    const loteGeneratedByMap = new Map<string, Types.ObjectId>();
    for (const lote of lotes) {
      loteGeneratedByMap.set(lote._id.toString(), lote.generatedBy);
    }

    const crudos: EventoCrudo[] = [];

    for (const f of facturas) {
      const creador = loteGeneratedByMap.get(f.loteId.toString()) ?? null;
      crudos.push({
        fecha: createdAtDe(f),
        accion: 'crear',
        actorId: creador,
        tipoDocumento: 'Factura',
        numeroCompleto: f.fullNumber,
        inmuebleId: f.inmuebleId,
        valor: f.total,
        href: `/facturas/${f._id.toString()}`,
      });
      if (f.voidedAt && f.voidedBy) {
        crudos.push({
          fecha: f.voidedAt,
          accion: 'anular',
          actorId: f.voidedBy,
          tipoDocumento: 'Factura',
          numeroCompleto: f.fullNumber,
          inmuebleId: f.inmuebleId,
          valor: f.total,
          href: `/facturas/${f._id.toString()}`,
        });
      }
    }

    for (const r of recibos) {
      crudos.push({
        fecha: createdAtDe(r),
        accion: 'crear',
        actorId: r.generatedBy,
        tipoDocumento: 'Recibo',
        numeroCompleto: r.fullNumber,
        inmuebleId: r.inmuebleId,
        valor: r.receivedAmount,
        href: `/recibos/${r._id.toString()}`,
      });
      if (r.voidedAt && r.voidedBy) {
        crudos.push({
          fecha: r.voidedAt,
          accion: 'anular',
          actorId: r.voidedBy,
          tipoDocumento: 'Recibo',
          numeroCompleto: r.fullNumber,
          inmuebleId: r.inmuebleId,
          valor: r.receivedAmount,
          href: `/recibos/${r._id.toString()}`,
        });
      }
    }

    for (const nc of notasCredito) {
      crudos.push({
        fecha: createdAtDe(nc),
        accion: 'crear',
        actorId: nc.generatedBy,
        tipoDocumento: 'Nota Crédito',
        numeroCompleto: nc.fullNumber,
        inmuebleId: nc.inmuebleId,
        valor: nc.totalAmount,
        href: `/notas-credito/${nc._id.toString()}`,
      });
      if (nc.voidedAt && nc.voidedBy) {
        crudos.push({
          fecha: nc.voidedAt,
          accion: 'anular',
          actorId: nc.voidedBy,
          tipoDocumento: 'Nota Crédito',
          numeroCompleto: nc.fullNumber,
          inmuebleId: nc.inmuebleId,
          valor: nc.totalAmount,
          href: `/notas-credito/${nc._id.toString()}`,
        });
      }
    }

    for (const nd of notasDebito) {
      crudos.push({
        fecha: createdAtDe(nd),
        accion: 'crear',
        actorId: nd.generatedBy,
        tipoDocumento: 'Nota Débito',
        numeroCompleto: nd.fullNumber,
        inmuebleId: nd.inmuebleId,
        valor: nd.total,
        href: `/notas-debito/${nd._id.toString()}`,
      });
      if (nd.voidedAt && nd.voidedBy) {
        crudos.push({
          fecha: nd.voidedAt,
          accion: 'anular',
          actorId: nd.voidedBy,
          tipoDocumento: 'Nota Débito',
          numeroCompleto: nd.fullNumber,
          inmuebleId: nd.inmuebleId,
          valor: nd.total,
          href: `/notas-debito/${nd._id.toString()}`,
        });
      }
    }

    for (const nt of notasContables) {
      crudos.push({
        fecha: createdAtDe(nt),
        accion: 'crear',
        actorId: nt.generatedBy,
        tipoDocumento: 'Nota Contable',
        numeroCompleto: nt.fullNumber,
        inmuebleId: nt.inmuebleId,
        valor: nt.monto,
        href: `/notas-contables/${nt._id.toString()}`,
      });
      if (nt.voidedAt && nt.voidedBy) {
        crudos.push({
          fecha: nt.voidedAt,
          accion: 'anular',
          actorId: nt.voidedBy,
          tipoDocumento: 'Nota Contable',
          numeroCompleto: nt.fullNumber,
          inmuebleId: nt.inmuebleId,
          valor: nt.monto,
          href: `/notas-contables/${nt._id.toString()}`,
        });
      }
    }

    for (const na of notasAnticipo) {
      crudos.push({
        fecha: createdAtDe(na),
        accion: 'crear',
        actorId: na.generatedBy,
        tipoDocumento: 'Nota de Anticipo',
        numeroCompleto: na.fullNumber,
        inmuebleId: na.inmuebleId,
        valor: na.appliedAmount,
        href: `/notas-anticipo/${na._id.toString()}`,
      });
      if (na.voidedAt && na.voidedBy) {
        crudos.push({
          fecha: na.voidedAt,
          accion: 'anular',
          actorId: na.voidedBy,
          tipoDocumento: 'Nota de Anticipo',
          numeroCompleto: na.fullNumber,
          inmuebleId: na.inmuebleId,
          valor: na.appliedAmount,
          href: `/notas-anticipo/${na._id.toString()}`,
        });
      }
    }

    // Batch-resolve every distinct actor (creator/voider across all 6
    // types) and every distinct inmueble in one query each, instead of one
    // query per row.
    const actorIds = [
      ...new Set(
        crudos
          .map((e) => e.actorId?.toString())
          .filter((id): id is string => id !== undefined),
      ),
    ].map((id) => new Types.ObjectId(id));
    const inmuebleIds = [
      ...new Set(crudos.map((e) => e.inmuebleId.toString())),
    ].map((id) => new Types.ObjectId(id));

    const [cuentas, inmuebles] = await Promise.all([
      actorIds.length
        ? this.accounts.find({ _id: { $in: actorIds } }).exec()
        : Promise.resolve([]),
      inmuebleIds.length
        ? this.inmuebles
            .find({ coPropertyId, _id: { $in: inmuebleIds } })
            .exec()
        : Promise.resolve([]),
    ]);

    const nombreCuentaMap = new Map<string, string>();
    for (const c of cuentas) {
      nombreCuentaMap.set(c._id.toString(), c.fullName);
    }
    const codigoInmuebleMap = new Map<string, string>();
    for (const i of inmuebles) {
      codigoInmuebleMap.set(i._id.toString(), i.code);
    }

    // Distinct-actor list for the frontend's own Usuario filter dropdown —
    // built from the FULL unfiltered set of events, independent of
    // whatever filter is applied to `items` below.
    const usuarios = [...nombreCuentaMap.entries()]
      .map(([accountId, nombre]) => ({ accountId, nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

    let eventos: EventoAuditoria[] = crudos.map((e) => ({
      fecha: e.fecha.toISOString(),
      usuarioId: e.actorId?.toString() ?? '',
      usuarioNombre: e.actorId
        ? (nombreCuentaMap.get(e.actorId.toString()) ?? 'Desconocido')
        : 'Desconocido',
      accion: e.accion,
      tipoDocumento: e.tipoDocumento,
      numeroCompleto: e.numeroCompleto,
      inmuebleCodigo: codigoInmuebleMap.get(e.inmuebleId.toString()) ?? '',
      valor: e.valor,
      href: e.href,
    }));

    if (filtros.usuarioId) {
      eventos = eventos.filter((e) => e.usuarioId === filtros.usuarioId);
    }
    if (filtros.tipoDocumento) {
      eventos = eventos.filter(
        (e) => e.tipoDocumento === filtros.tipoDocumento,
      );
    }
    if (filtros.numero) {
      const buscado = filtros.numero.toLowerCase();
      eventos = eventos.filter((e) =>
        e.numeroCompleto.toLowerCase().includes(buscado),
      );
    }
    if (filtros.desde) {
      const desde = new Date(filtros.desde);
      eventos = eventos.filter((e) => new Date(e.fecha) >= desde);
    }
    if (filtros.hasta) {
      const hasta = new Date(filtros.hasta);
      eventos = eventos.filter((e) => new Date(e.fecha) <= hasta);
    }

    eventos.sort(
      (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
    );

    const total = eventos.length;
    const inicio = (pagina - 1) * porPagina;
    const items = eventos.slice(inicio, inicio + porPagina);

    return { items, total, pagina, porPagina, usuarios };
  }
}
