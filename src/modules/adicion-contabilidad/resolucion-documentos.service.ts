import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import type { AsientoContableDocument } from '../../database/schemas/facturacion/asiento-contable.schema';
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
  SaldoInicialAnticipo,
  SaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import {
  resolverSaldosInicialesPorNumero,
  type DocumentoCruceSaldoInicial,
} from '../saldos-iniciales/saldo-inicial-cruce.util';
import { resolveAnchorId } from '../consultas/movimiento-contable.util';
import { fechaDdMmAaaa } from './movmes.util';

/** "Tipo documento" as the accounting exports expect it — mostly the same
 *  codes `movimiento-contable.util.ts`'s `deriveTipoDocumento` already uses
 *  internally, EXCEPT Factura: that report calls it 'FC', but the exports use
 *  'FV' — the code actually configured everywhere else in this app
 *  (ConsecutivoDocumento.categoria, Movimiento.tipoDocumento cross-reference)
 *  for a sales invoice. Shared by MOVMES/MOVMESDO and the Comptable payload. */
export type TipoDocumentoExport = 'FV' | 'RC' | 'NC' | 'ND' | 'NT' | 'NA';

export const tipoDocumentoDe = (
  asiento: Pick<
    AsientoContableDocument,
    | 'facturaId'
    | 'reciboId'
    | 'notaCreditoId'
    | 'notaDebitoId'
    | 'notaContableId'
    | 'notaAnticipoId'
  >,
): TipoDocumentoExport => {
  if (asiento.facturaId) return 'FV';
  if (asiento.reciboId) return 'RC';
  if (asiento.notaCreditoId) return 'NC';
  if (asiento.notaDebitoId) return 'ND';
  if (asiento.notaContableId) return 'NT';
  return 'NA';
};

/** The anchor document's own prefix and number, as stored on it. */
export type AnchorInfo = { prefix: string; number: number };

/**
 * The "detalle" an accounting export shows for one asiento: the document's
 * own concepto (see `resolveConceptos`) — the accountant reads THIS in the
 * target system, never the internal ledger's fixed catalog wording. Falls
 * back to that internal wording only when the source document left its own
 * concepto empty (RC/NC/ND's optional field).
 */
export const detalleDeAsiento = (
  asiento: Pick<
    AsientoContableDocument,
    | 'facturaId'
    | 'reciboId'
    | 'notaCreditoId'
    | 'notaDebitoId'
    | 'notaContableId'
    | 'notaAnticipoId'
    | 'movimientos'
  >,
  conceptoMap: Map<string, string>,
): string =>
  conceptoMap.get(resolveAnchorId(asiento).toString()) ??
  asiento.movimientos[0]?.descripcion ??
  '';

/**
 * Resolves, for a batch of `AsientoContable`, what every accounting export
 * needs from the source documents: each anchor's own prefix/number, each
 * document's concepto, and the original document behind a Saldo Inicial
 * cross-reference. Extracted from `AdicionContabilidadService` so the CSV
 * export and the Comptable push read the SAME resolution (one source of
 * truth for "what this asiento is called"), never a copy.
 *
 * Every query is tenant-scoped by the `copropiedadId` the caller resolved
 * from the request context. `session` is null outside a transaction.
 *
 * The two Saldo Inicial models are optional: `AdicionContabilidadService`
 * builds this class from its own positional (and partly optional)
 * constructor arguments, and its older tests stop before them.
 */
@Injectable()
export class ResolucionDocumentosService {
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
    @InjectModel(SaldoInicialAnticipo.name)
    private readonly saldosInicialesAnticipo?: Model<SaldoInicialAnticipoDocument>,
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales?: Model<SaldoInicialDocument>,
  ) {}

  /** Batch-resolves `{prefix, number}` for every anchor document referenced
   *  by this batch of asientos — same fan-out-by-type shape as
   *  `MovimientoContableService.buildAnchorMap`, but the exports only need
   *  the bare number/prefix, not inmueble metadata. */
  async buildAnchorMap(
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    session: ClientSession | null,
  ): Promise<Map<string, AnchorInfo>> {
    const map = new Map<string, AnchorInfo>();

    const idsByType = this.idsPorTipo(asientos);

    const fetchers: Array<
      [
        TipoDocumentoExport,
        Model<{ _id: Types.ObjectId; prefijo: string; numero: number }>,
      ]
    > = [
      ['FV', this.facturas as never],
      ['RC', this.recibos as never],
      ['NC', this.notasCredito as never],
      ['ND', this.notasDebito as never],
      ['NT', this.notasContables as never],
      ['NA', this.notasAnticipo as never],
    ];

    for (const [tipo, model] of fetchers) {
      const ids = idsByType.get(tipo);
      if (!ids || ids.length === 0) continue;
      const docs = await model
        .find({ _id: { $in: ids }, copropiedadId }, { prefijo: 1, numero: 1 })
        .session(session)
        .exec();
      for (const doc of docs) {
        map.set(doc._id.toString(), {
          prefix: doc.prefijo,
          number: doc.numero,
        });
      }
    }

    return map;
  }

  /**
   * Batch-resolves the "detalle" the target accounting system actually wants
   * per anchor document — the concepto the user typed on that document
   * (Observaciones/Detalle/Descripción), NOT `entries[].description`'s fixed
   * internal ledger wording (see `detalleDeAsiento` for the fallback).
   * RC/NC/ND/NT read straight off their own field; FV and NA have none, so
   * their text is composed instead — see each branch below.
   */
  async resolveConceptos(
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    session: ClientSession | null,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    const idsByType = this.idsPorTipo(asientos);

    const agregarSiNoVacio = (
      id: Types.ObjectId,
      texto: string | null | undefined,
    ): void => {
      if (texto && texto.trim()) map.set(id.toString(), texto);
    };

    const reciboIds = idsByType.get('RC');
    if (reciboIds && reciboIds.length > 0) {
      const recibos = await this.recibos
        .find({ _id: { $in: reciboIds }, copropiedadId }, { observaciones: 1 })
        .session(session)
        .exec();
      for (const r of recibos) agregarSiNoVacio(r._id, r.observaciones);
    }

    const notaCreditoIds = idsByType.get('NC');
    if (notaCreditoIds && notaCreditoIds.length > 0) {
      const notasCredito = await this.notasCredito
        .find(
          { _id: { $in: notaCreditoIds }, copropiedadId },
          { observaciones: 1 },
        )
        .session(session)
        .exec();
      for (const n of notasCredito) agregarSiNoVacio(n._id, n.observaciones);
    }

    const notaDebitoIds = idsByType.get('ND');
    if (notaDebitoIds && notaDebitoIds.length > 0) {
      const notasDebito = await this.notasDebito
        .find(
          { _id: { $in: notaDebitoIds }, copropiedadId },
          { descripcion: 1 },
        )
        .session(session)
        .exec();
      for (const n of notasDebito) agregarSiNoVacio(n._id, n.descripcion);
    }

    const notaContableIds = idsByType.get('NT');
    if (notaContableIds && notaContableIds.length > 0) {
      const notasContables = await this.notasContables
        .find(
          { _id: { $in: notaContableIds }, copropiedadId },
          { descripcion: 1 },
        )
        .session(session)
        .exec();
      for (const n of notasContables) agregarSiNoVacio(n._id, n.descripcion);
    }

    // FV: no free-text field on the invoice itself — the period it bills,
    // same for every line regardless of conceptName, per the accountant's
    // own request (replaces `linea.conceptName` in the exports only).
    const facturaIds = idsByType.get('FV');
    if (facturaIds && facturaIds.length > 0) {
      const facturas = await this.facturas
        .find(
          { _id: { $in: facturaIds }, copropiedadId },
          { periodoDesde: 1, periodoHasta: 1 },
        )
        .session(session)
        .exec();
      for (const f of facturas) {
        map.set(
          f._id.toString(),
          `Cargo del Periodo ${fechaDdMmAaaa(f.periodoDesde)} - ${fechaDdMmAaaa(f.periodoHasta)}`,
        );
      }
    }

    // NA: no free-text field either — composed from the Recibo it draws its
    // anticipo from, per the accountant's own request. When the origin is a
    // Saldo Inicial de Anticipo (`origenTipo: 'SI'`) there is no Recibo: it
    // is composed from the document it was in the previous system instead
    // (`RC # 1234`), same shape.
    const notaAnticipoIds = idsByType.get('NA');
    if (notaAnticipoIds && notaAnticipoIds.length > 0) {
      const notasAnticipo = await this.notasAnticipo
        .find(
          { _id: { $in: notaAnticipoIds }, copropiedadId },
          { reciboOrigenId: 1, origenTipo: 1 },
        )
        .session(session)
        .exec();
      const esSaldoInicial = (n: (typeof notasAnticipo)[number]): boolean =>
        n.origenTipo === 'SI';
      const idsDeOrigen = (si: boolean): Types.ObjectId[] =>
        [
          ...new Set(
            notasAnticipo
              .filter((n) => esSaldoInicial(n) === si)
              .map((n) => n.reciboOrigenId.toString()),
          ),
        ].map((id) => new Types.ObjectId(id));
      const reciboOrigenIds = idsDeOrigen(false);
      const saldoInicialOrigenIds = idsDeOrigen(true);
      const saldosIniciales =
        this.saldosInicialesAnticipo && saldoInicialOrigenIds.length > 0
          ? await this.saldosInicialesAnticipo
              .find(
                { _id: { $in: saldoInicialOrigenIds }, copropiedadId },
                { tipoDocumentoOriginal: 1, numeroOriginal: 1 },
              )
              .session(session)
              .exec()
          : [];
      const etiquetaPorSaldoInicial = new Map(
        saldosIniciales.map((si) => [
          si._id.toString(),
          `${si.tipoDocumentoOriginal} # ${si.numeroOriginal}`,
        ]),
      );
      const recibos = await this.recibos
        .find({ _id: { $in: reciboOrigenIds }, copropiedadId }, { numero: 1 })
        .session(session)
        .exec();
      const numeroPorRecibo = new Map(
        recibos.map((r) => [r._id.toString(), r.numero]),
      );
      for (const n of notasAnticipo) {
        if (esSaldoInicial(n)) {
          const etiqueta = etiquetaPorSaldoInicial.get(
            n.reciboOrigenId.toString(),
          );
          if (etiqueta !== undefined) {
            map.set(n._id.toString(), `Aplicación de Anticipo ${etiqueta}`);
          }
          continue;
        }
        const numero = numeroPorRecibo.get(n.reciboOrigenId.toString());
        if (numero !== undefined) {
          map.set(n._id.toString(), `Aplicación de Anticipo RC # ${numero}`);
        }
      }
    }

    return map;
  }

  /** The original document behind every Saldo Inicial cross-reference in
   *  this batch (see `resolverSaldosInicialesPorNumero`), keyed by the
   *  internal ordinal. */
  resolverSaldosIniciales(
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    session: ClientSession | null,
  ): Promise<Map<number, DocumentoCruceSaldoInicial>> {
    return resolverSaldosInicialesPorNumero(
      this.saldosIniciales,
      copropiedadId,
      asientos,
      session ?? undefined,
    );
  }

  private idsPorTipo(
    asientos: AsientoContableDocument[],
  ): Map<TipoDocumentoExport, Types.ObjectId[]> {
    const idsByType = new Map<TipoDocumentoExport, Types.ObjectId[]>();
    for (const a of asientos) {
      const tipo = tipoDocumentoDe(a);
      const list = idsByType.get(tipo) ?? [];
      list.push(resolveAnchorId(a));
      idsByType.set(tipo, list);
    }
    return idsByType;
  }
}
