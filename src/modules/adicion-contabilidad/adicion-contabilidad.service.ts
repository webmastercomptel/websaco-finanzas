import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  LoteContabilidad,
  LoteContabilidadDocument,
} from '../../database/schemas/contabilidad/lote-contabilidad.schema';
import {
  ConsecutivoLoteContabilidad,
  ConsecutivoLoteContabilidadDocument,
} from '../../database/schemas/contabilidad/consecutivo-lote-contabilidad.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
  CategoriaDocumento,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import { resolveAnchorId } from '../consultas/movimiento-contable.util';
import { toLoteContabilidad } from './adicion-contabilidad.mapper';
import {
  construirMovmes,
  construirMovmesdo,
  fechaDdMmAaaa,
  type FilaMovmes,
  type FilaMovmesdo,
} from './movmes.util';
import type {
  LoteContabilidad as LoteContabilidadContract,
  RespuestaAdicionContabilidad,
} from '../../contracts';

/** "Tipo documento" as this export's own target system expects it — mostly
 *  the same codes `movimiento-contable.util.ts`'s `deriveTipoDocumento`
 *  already uses internally, EXCEPT Factura: that report calls it 'FC', but
 *  this export uses 'FV' — the code actually configured everywhere else in
 *  this app (ConsecutivoDocumento.category, Movimiento.tipoDocumento cross-
 *  reference) for a sales invoice. */
type TipoDocumentoExport = 'FV' | 'RC' | 'NC' | 'ND' | 'NT' | 'NA';

const tipoDocumentoDe = (
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

/** Maps this export's tipo documento back to `ConsecutivoDocumento`'s own
 *  fixed `category` — null for FV (Facturas number off a DIAN resolución,
 *  never a ConsecutivoDocumento row, see that schema's own docblock) and NA
 *  (Notas de Anticipo have no category of their own at all). Both cases
 *  simply have no "comprobante" to look up. */
const categoriaDe = (tipo: TipoDocumentoExport): CategoriaDocumento | null => {
  switch (tipo) {
    case 'RC':
      return 'IN';
    case 'NC':
      return 'NC';
    case 'ND':
      return 'ND';
    case 'NT':
      return 'NT';
    default:
      return null;
  }
};

type AnchorInfo = { prefix: string; number: number };

@Injectable()
export class AdicionContabilidadService {
  constructor(
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(LoteContabilidad.name)
    private readonly lotes: Model<LoteContabilidadDocument>,
    @InjectModel(ConsecutivoLoteContabilidad.name)
    private readonly consecutivosLote: Model<ConsecutivoLoteContabilidadDocument>,
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivosDocumento: Model<ConsecutivoDocumentoDocument>,
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
    private readonly tenant: TenantContextService,
    private readonly lotesFacturacion: LotesFacturacionService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

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

  /** History of past generations — the "control" this feature exists to
   *  provide: what was already exported, and when. */
  async listar(): Promise<LoteContabilidadContract[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const docs = await this.lotes
      .find({ copropiedadId })
      .sort({ number: -1 })
      .exec();
    return docs.map(toLoteContabilidad);
  }

  /**
   * Generates MOVMES.csv/MOVMESDO.csv from every `AsientoContable` in the
   * current billing period not yet stamped by a previous generation, then
   * stamps them so a later call — however many times this is run within the
   * same period — never re-exports the same rows (the one hard requirement
   * driving this whole feature: "para que no se vuelvan a adicionar").
   */
  async generar(accountId: string): Promise<RespuestaAdicionContabilidad> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const ultimoLote = await this.lotesFacturacion.obtenerUltimoConsolidado(
      copropiedadId.toString(),
    );
    if (!ultimoLote) {
      throw new BadRequestException(
        'Esta copropiedad todavía no tiene un período de facturación consolidado.',
      );
    }

    return this.transaccion(async (session) => {
      const asientos = await this.asientos
        .find({
          copropiedadId,
          contabilidadLoteId: null,
          fecha: {
            $gte: ultimoLote.periodoDesde,
            $lte: ultimoLote.periodoHasta,
          },
        })
        .sort({ fecha: 1, _id: 1 })
        .session(session)
        .exec();

      if (asientos.length === 0) {
        throw new ConflictException(
          'No hay movimientos nuevos por adicionar en el período actual.',
        );
      }

      const anchorMap = await this.buildAnchorMap(
        asientos,
        copropiedadId,
        session,
      );
      const conceptoMap = await this.resolveConceptos(
        asientos,
        copropiedadId,
        session,
      );
      const comprobantePorClave = await this.resolveComprobantes(
        asientos,
        anchorMap,
        copropiedadId,
        session,
      );

      const consecutivo = await this.consecutivosLote
        .findOneAndUpdate(
          { copropiedadId },
          { $inc: { nextNumber: 1 } },
          { returnDocument: 'after', upsert: true, session },
        )
        .exec();
      const numeroLote = consecutivo.nextNumber;

      const filasMovmes: FilaMovmes[] = [];
      const filasMovmesdo: FilaMovmesdo[] = [];

      for (const asiento of asientos) {
        const tipoDocumento = tipoDocumentoDe(asiento);
        const anchorIdStr = resolveAnchorId(asiento).toString();
        const anchor = anchorMap.get(anchorIdStr);
        // The document's own concepto (Observaciones/Detalle/Descripción, or
        // the NA/FV composed text) — the accountant reads THIS in the target
        // system, never the internal ledger's fixed catalog wording. Falls
        // back to that internal wording only when the source document left
        // its own concepto empty (RC/NC/ND's optional field).
        const detalle =
          conceptoMap.get(anchorIdStr) ??
          asiento.movimientos[0]?.descripcion ??
          '';

        filasMovmes.push({
          tipoDocumento,
          numero: anchor?.number ?? 0,
          fecha: asiento.fecha,
          numeroLote,
          detalle,
        });

        const comprobante =
          comprobantePorClave.get(`${tipoDocumento}:${anchor?.prefix ?? ''}`) ??
          null;

        for (const entry of asiento.movimientos) {
          filasMovmesdo.push({
            tipoDocumento,
            numero: anchor?.number ?? 0,
            cuenta: entry.cuenta,
            centroCosto: entry.centroCosto ?? null,
            tercero: entry.tercero ?? null,
            detalle,
            baseGravable: entry.baseGravable ?? null,
            valorDebito: entry.tipo === 'debito' ? entry.monto : null,
            valorCredito: entry.tipo === 'credito' ? entry.monto : null,
            comprobante,
            numeroDocCruce: entry.numeroDocumento ?? null,
          });
        }
      }

      const [loteCreado] = await this.lotes.create(
        [
          {
            copropiedadId,
            number: numeroLote,
            periodStart: ultimoLote.periodoDesde,
            periodEnd: ultimoLote.periodoHasta,
            totalAsientos: asientos.length,
            generatedBy: accountId,
          },
        ],
        { session },
      );

      await this.asientos.updateMany(
        { _id: { $in: asientos.map((a) => a._id) } },
        { $set: { contabilidadLoteId: loteCreado._id } },
        { session },
      );

      return {
        lote: toLoteContabilidad(loteCreado),
        movmes: construirMovmes(filasMovmes),
        movmesdo: construirMovmesdo(filasMovmesdo),
      };
    });
  }

  /** Batch-resolves `{prefix, number}` for every anchor document referenced
   *  by this batch of asientos — same fan-out-by-type shape as
   *  `MovimientoContableService.buildAnchorMap`, but this export only needs
   *  the bare number/prefix, not inmueble metadata. */
  private async buildAnchorMap(
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    session: ClientSession,
  ): Promise<Map<string, AnchorInfo>> {
    const map = new Map<string, AnchorInfo>();

    const idsByType = new Map<TipoDocumentoExport, Types.ObjectId[]>();
    for (const a of asientos) {
      const tipo = tipoDocumentoDe(a);
      const list = idsByType.get(tipo) ?? [];
      list.push(resolveAnchorId(a));
      idsByType.set(tipo, list);
    }

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
   * internal ledger wording (see `generar()`'s own comment on the fallback).
   * RC/NC/ND/NT read straight off their own field; FV and NA have none, so
   * their text is composed instead — see each branch below.
   */
  private async resolveConceptos(
    asientos: AsientoContableDocument[],
    copropiedadId: Types.ObjectId,
    session: ClientSession,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    const idsByType = new Map<TipoDocumentoExport, Types.ObjectId[]>();
    for (const a of asientos) {
      const tipo = tipoDocumentoDe(a);
      const list = idsByType.get(tipo) ?? [];
      list.push(resolveAnchorId(a));
      idsByType.set(tipo, list);
    }

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
    // own request (replaces `linea.conceptName` in THIS export only).
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
    // anticipo from, per the accountant's own request.
    const notaAnticipoIds = idsByType.get('NA');
    if (notaAnticipoIds && notaAnticipoIds.length > 0) {
      const notasAnticipo = await this.notasAnticipo
        .find(
          { _id: { $in: notaAnticipoIds }, copropiedadId },
          { reciboOrigenId: 1 },
        )
        .session(session)
        .exec();
      const reciboOrigenIds = [
        ...new Set(notasAnticipo.map((n) => n.reciboOrigenId.toString())),
      ].map((id) => new Types.ObjectId(id));
      const recibos = await this.recibos
        .find({ _id: { $in: reciboOrigenIds }, copropiedadId }, { numero: 1 })
        .session(session)
        .exec();
      const numeroPorRecibo = new Map(
        recibos.map((r) => [r._id.toString(), r.numero]),
      );
      for (const n of notasAnticipo) {
        const numero = numeroPorRecibo.get(n.reciboOrigenId.toString());
        if (numero !== undefined) {
          map.set(n._id.toString(), `Aplicación de Anticipo RC # ${numero}`);
        }
      }
    }

    return map;
  }

  /** Batch-resolves "comprobante" (`ConsecutivoDocumento.accountingVoucherCode`)
   *  per (tipoDocumento, prefix) pair actually present in this batch — a
   *  document itself only remembers its `prefix`, never which specific
   *  código it was numbered under, so this matches back to the
   *  ConsecutivoDocumento row sharing that category+prefix. FV and NA never
   *  have one (see `categoriaDe`'s own docblock) and are skipped. */
  private async resolveComprobantes(
    asientos: AsientoContableDocument[],
    anchorMap: Map<string, AnchorInfo>,
    copropiedadId: Types.ObjectId,
    session: ClientSession,
  ): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    const claves = new Set<string>();
    for (const a of asientos) {
      const tipo = tipoDocumentoDe(a);
      const anchor = anchorMap.get(resolveAnchorId(a).toString());
      if (!anchor) continue;
      const categoria = categoriaDe(tipo);
      if (!categoria) continue;
      claves.add(`${tipo}:${anchor.prefix}:${categoria}`);
    }
    if (claves.size === 0) return map;

    const categorias = [
      ...new Set([...claves].map((c) => c.split(':')[2] as CategoriaDocumento)),
    ];
    const consecutivos = await this.consecutivosDocumento
      .find({ copropiedadId, category: { $in: categorias } })
      .session(session)
      .exec();

    for (const clave of claves) {
      const [tipo, prefix, categoria] = clave.split(':');
      const consecutivo = consecutivos.find(
        (c) => c.category === categoria && c.prefix === prefix,
      );
      map.set(`${tipo}:${prefix}`, consecutivo?.accountingVoucherCode ?? null);
    }
    return map;
  }
}
