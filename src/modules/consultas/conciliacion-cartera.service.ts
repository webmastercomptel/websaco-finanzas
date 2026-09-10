import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
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
  AplicacionCartera,
  AplicacionCarteraDocument,
  SourceType,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { calcularDocumentosConSaldoAFecha } from './cartera-historica.util';
import type {
  ConceptoConciliacionCartera,
  FilaConciliacionCartera,
  PeriodoFacturado,
  RespuestaConciliacionCartera,
} from '../../contracts';
import type { ConsultarConciliacionCarteraDto } from './dto/consultar-conciliacion-cartera.dto';

/** A source document, reduced to what a doc-range lookup needs. */
type FuenteAplicacion = {
  _id: Types.ObjectId;
  fullNumber: string;
  number: number;
};

const ETIQUETAS: Record<ConceptoConciliacionCartera, string> = {
  facturacion: 'Facturación',
  recibos_caja: 'Ingresos por Recibos de Caja',
  anulacion_recibos_caja: 'Anulación de Recibos de Caja',
  notas_credito: 'Notas Crédito',
  anulacion_notas_credito: 'Anulación de Notas Crédito',
  notas_debito: 'Notas Débito',
  anulacion_notas_debito: 'Anulación de Notas Débito',
  notas_anticipo: 'Notas de Anticipo',
  anulacion_notas_anticipo: 'Anulación de Notas de Anticipo',
  notas_contables: 'Notas Contables',
};

/**
 * Coproperty-wide accounts-receivable reconciliation: for one period, checks
 * that Saldo Anterior + the period's own débitos − créditos (broken down by
 * the ten fixed kardex concepts — pure arithmetic) lands on the same total
 * the `SaldoCartera` table actually carries right now. Sibling to Estado de
 * Cuenta (which does the equivalent for one inmueble); this one has no
 * inmueble dimension — every query here is coproperty-wide, matching the
 * printed format this replaces (see this task's own reference spreadsheet).
 */
@Injectable()
export class ConciliacionCarteraService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
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
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldosCartera: Model<SaldoCarteraDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Every distinct (periodStart, periodEnd) pair across every Factura in the
   * coproperty, sorted most-recent-first — same dedup as Estado de Cuenta's
   * own `findPeriodos`, minus the per-inmueble filter this report has no use
   * for.
   */
  async findPeriodos(): Promise<PeriodoFacturado[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const facturas = await this.facturas
      .find({ coPropertyId, status: 'emitida' })
      .sort({ periodStart: -1 })
      .exec();

    const seen = new Set<string>();
    const result: PeriodoFacturado[] = [];
    for (const f of facturas) {
      const key = `${f.periodStart.toISOString()}|${f.periodEnd.toISOString()}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          periodStart: f.periodStart.toISOString(),
          periodEnd: f.periodEnd.toISOString(),
        });
      }
    }
    return result;
  }

  async findAll(
    query: ConsultarConciliacionCarteraDto,
  ): Promise<RespuestaConciliacionCartera> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const desde = new Date(query.periodStart);
    const hasta = new Date(query.periodEnd);
    const antesDelPeriodo = new Date(desde.getTime() - 1);

    const [saldoAnteriorDocs, saldosCartera] = await Promise.all([
      // Saldo Anterior has no live table to read — it's a point-in-time
      // reconstruction as of the instant before this period started, the
      // same historical-balance utility Cartera General uses.
      calcularDocumentosConSaldoAFecha(
        {
          facturas: this.facturas,
          notasDebito: this.notasDebito,
          aplicaciones: this.aplicaciones,
        },
        coPropertyId,
        antesDelPeriodo,
      ),
      // Saldo de Cartera is NOT recomputed — it's read straight from the
      // `SaldoCartera` table, the maintained running-balance cache every
      // other cartera screen (Cartera General's "por concepto" breakdown,
      // Cartera por Inmueble) trusts as the system's own number. Comparing
      // the period's own arithmetic against THIS, not a fresh
      // reconstruction, is the whole point of the report: it catches the
      // cache actually drifting from the documents that are supposed to
      // maintain it (see `SaldoCartera`'s own "reconcilable cache, never a
      // second source of truth" docblock).
      this.saldosCartera.find({ coPropertyId }).exec(),
    ]);
    const saldoAnterior = saldoAnteriorDocs.reduce(
      (sum, d) => sum + d.montoPendiente,
      0,
    );
    const saldoCarteraReal = saldosCartera.reduce(
      (sum, s) => sum + s.balance,
      0,
    );

    const conceptos: FilaConciliacionCartera[] = [];
    let totalDebito = 0;
    let totalCredito = 0;

    const agregar = (
      concepto: ConceptoConciliacionCartera,
      desdeDoc: string | null,
      hastaDoc: string | null,
      valorDebito: number,
      valorCredito: number,
    ): void => {
      conceptos.push({
        concepto,
        etiqueta: ETIQUETAS[concepto],
        desde: desdeDoc,
        hasta: hastaDoc,
        valorDebito,
        valorCredito,
      });
      totalDebito += valorDebito;
      totalCredito += valorCredito;
    };

    // Facturación → débito
    {
      const docs = await this.facturas
        .find({
          coPropertyId,
          status: 'emitida',
          issueDate: { $gte: desde, $lte: hasta },
        })
        .sort({ number: 1 })
        .exec();
      const valor = docs.reduce((sum, d) => sum + d.total, 0);
      agregar('facturacion', primero(docs), ultimo(docs), valor, 0);
    }

    // Ingresos por Recibos de Caja → crédito. `receivedDate` is the date the
    // user declared for the payment (`dto.fechaRecibo`) — never
    // `AplicacionCartera.appliedAt`, which is always `new Date()` at cruce
    // time and can land outside the period the payment was actually FOR
    // (see `movimientoDeFuentes`'s own docblock).
    {
      const recibosEnPeriodo = await this.recibos
        .find({ coPropertyId, receivedDate: { $gte: desde, $lte: hasta } })
        .sort({ number: 1 })
        .exec();
      const { valor, desdeDoc, hastaDoc } = await this.movimientoDeFuentes(
        coPropertyId,
        'RC',
        'activa',
        recibosEnPeriodo,
      );
      agregar('recibos_caja', desdeDoc, hastaDoc, 0, valor);
    }

    // Anulación de Recibos de Caja → débito (reversa el ingreso). Keyed by
    // the Recibo's own `voidedAt` — the real moment the void happened, same
    // field Notas Débito's own anulación row uses below.
    {
      const recibosAnulados = await this.recibos
        .find({
          coPropertyId,
          status: 'anulado',
          voidedAt: { $gte: desde, $lte: hasta },
        })
        .sort({ number: 1 })
        .exec();
      const { valor, desdeDoc, hastaDoc } = await this.movimientoDeFuentes(
        coPropertyId,
        'RC',
        'revertida',
        recibosAnulados,
      );
      agregar('anulacion_recibos_caja', desdeDoc, hastaDoc, valor, 0);
    }

    // Notas Crédito → crédito. `issueDate` ?? `createdAt` — the exact
    // fallback `fechaNotaCredito` uses for a note created before that field
    // existed (mirrors `NotasCreditoService.findAll`'s identical `$or`).
    {
      const rango = { $gte: desde, $lte: hasta };
      const notasEnPeriodo = await this.notasCredito
        .find({
          coPropertyId,
          $or: [{ issueDate: rango }, { issueDate: null, createdAt: rango }],
        })
        .sort({ number: 1 })
        .exec();
      const { valor, desdeDoc, hastaDoc } = await this.movimientoDeFuentes(
        coPropertyId,
        'NC',
        'activa',
        notasEnPeriodo,
      );
      agregar('notas_credito', desdeDoc, hastaDoc, 0, valor);
    }

    // Anulación de Notas Crédito → débito
    {
      const notasAnuladas = await this.notasCredito
        .find({
          coPropertyId,
          status: 'anulado',
          voidedAt: { $gte: desde, $lte: hasta },
        })
        .sort({ number: 1 })
        .exec();
      const { valor, desdeDoc, hastaDoc } = await this.movimientoDeFuentes(
        coPropertyId,
        'NC',
        'revertida',
        notasAnuladas,
      );
      agregar('anulacion_notas_credito', desdeDoc, hastaDoc, valor, 0);
    }

    // Notas Débito → débito
    {
      const docs = await this.notasDebito
        .find({
          coPropertyId,
          status: 'emitida',
          issueDate: { $gte: desde, $lte: hasta },
        })
        .sort({ number: 1 })
        .exec();
      const valor = docs.reduce((sum, d) => sum + d.total, 0);
      agregar('notas_debito', primero(docs), ultimo(docs), valor, 0);
    }

    // Anulación de Notas Débito → crédito
    {
      const docs = await this.notasDebito
        .find({
          coPropertyId,
          status: 'anulada',
          voidedAt: { $gte: desde, $lte: hasta },
        })
        .sort({ number: 1 })
        .exec();
      const valor = docs.reduce((sum, d) => sum + d.total, 0);
      agregar('anulacion_notas_debito', primero(docs), ultimo(docs), 0, valor);
    }

    // Notas de Anticipo → crédito
    {
      const notasEnPeriodo = await this.notasAnticipo
        .find({ coPropertyId, issueDate: { $gte: desde, $lte: hasta } })
        .sort({ number: 1 })
        .exec();
      const { valor, desdeDoc, hastaDoc } = await this.movimientoDeFuentes(
        coPropertyId,
        'NA',
        'activa',
        notasEnPeriodo,
      );
      agregar('notas_anticipo', desdeDoc, hastaDoc, 0, valor);
    }

    // Anulación de Notas de Anticipo → débito
    {
      const notasAnuladas = await this.notasAnticipo
        .find({
          coPropertyId,
          status: 'anulado',
          voidedAt: { $gte: desde, $lte: hasta },
        })
        .sort({ number: 1 })
        .exec();
      const { valor, desdeDoc, hastaDoc } = await this.movimientoDeFuentes(
        coPropertyId,
        'NA',
        'revertida',
        notasAnuladas,
      );
      agregar('anulacion_notas_anticipo', desdeDoc, hastaDoc, valor, 0);
    }

    // Notas Contables → débito Y crédito por el mismo total (neta cero, igual
    // que Estado de Cuenta las trata — mueve saldo entre conceptos de un
    // mismo inmueble, nunca cambia lo que la copropiedad tiene en cartera).
    {
      const filtro: Record<string, unknown> = {
        coPropertyId,
        status: 'activo',
        createdAt: { $gte: desde, $lte: hasta },
      };
      const docs = await this.notasContables
        .find(filtro)
        .sort({ number: 1 })
        .exec();
      const valor = docs.reduce((sum, d) => sum + d.monto, 0);
      agregar('notas_contables', primero(docs), ultimo(docs), valor, valor);
    }

    const saldoCarteraCalculado = saldoAnterior + totalDebito - totalCredito;
    const diferencia = saldoCarteraCalculado - saldoCarteraReal;

    return {
      periodStart: desde.toISOString(),
      periodEnd: hasta.toISOString(),
      saldoAnterior,
      conceptos,
      totalDebito,
      totalCredito,
      saldoCarteraCalculado,
      saldoCarteraReal,
      diferencia,
    };
  }

  /**
   * Sums `AplicacionCartera` rows of one `sourceType`/`status` whose SOURCE
   * document (`fuentes`) already appears in this concept row's window.
   *
   * `fuentes` is pre-filtered by the CALLER on that source document's own
   * declared business date — `Recibo.receivedDate`, `NotaCredito`'s
   * issueDate/createdAt, `NotaAnticipo.issueDate` — never
   * `AplicacionCartera.appliedAt`/`revertedAt` directly for the "activa"
   * case. `appliedAt` is always `new Date()` at cruce time, the moment
   * someone clicked "aplicar" — not the payment's own date — so a Recibo
   * dated last month but entered (and applied) today would silently vanish
   * from that period's report if this filtered by `appliedAt` instead. Same
   * reasoning Estado de Cuenta's own `reciboMap`/`ncMap` docblock gives for
   * the identical choice there.
   *
   * Sums the FULL `amountApplied` — never splitting out `discountApplied`
   * the way Estado de Cuenta does for its owner-facing "pago" vs "descuento"
   * categorías; `calcularDocumentosConSaldoAFecha` (used for
   * `saldoAnterior`/`saldoCarteraReal`) reduces a document's balance by the
   * whole `amountApplied` regardless of composition, so this row must
   * credit that same whole amount or `diferencia` reads false on any Recibo
   * that used an early-payment discount.
   *
   * `fuentes` may include documents with zero applications (e.g. a Recibo
   * received but kept entirely as anticipo) — `desde`/`hasta` only span the
   * ones that actually appear among `apps`, so an untouched receipt doesn't
   * widen the printed range.
   */
  private async movimientoDeFuentes(
    coPropertyId: Types.ObjectId,
    sourceType: SourceType,
    status: 'activa' | 'revertida',
    fuentes: FuenteAplicacion[],
  ): Promise<{
    valor: number;
    desdeDoc: string | null;
    hastaDoc: string | null;
  }> {
    if (fuentes.length === 0)
      return { valor: 0, desdeDoc: null, hastaDoc: null };

    const ids = fuentes.map((f) => f._id);
    const apps = await this.aplicaciones
      .find({ coPropertyId, sourceType, status, sourceId: { $in: ids } })
      .exec();
    if (apps.length === 0) return { valor: 0, desdeDoc: null, hastaDoc: null };

    const valor = apps.reduce((sum, a) => sum + a.amountApplied, 0);

    const idsConMovimiento = new Set(apps.map((a) => a.sourceId.toString()));
    const usados = fuentes
      .filter((f) => idsConMovimiento.has(f._id.toString()))
      .sort((a, b) => a.number - b.number);

    return { valor, desdeDoc: primero(usados), hastaDoc: ultimo(usados) };
  }
}

function primero(docs: Array<{ fullNumber: string }>): string | null {
  return docs[0]?.fullNumber ?? null;
}

function ultimo(docs: Array<{ fullNumber: string }>): string | null {
  return docs.length > 0 ? docs[docs.length - 1].fullNumber : null;
}
