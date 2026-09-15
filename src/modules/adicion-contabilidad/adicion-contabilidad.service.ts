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
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const docs = await this.lotes
      .find({ coPropertyId })
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
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const ultimoLote = await this.lotesFacturacion.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    if (!ultimoLote) {
      throw new BadRequestException(
        'Esta copropiedad todavía no tiene un período de facturación consolidado.',
      );
    }

    return this.transaccion(async (session) => {
      const asientos = await this.asientos
        .find({
          coPropertyId,
          contabilidadLoteId: null,
          date: { $gte: ultimoLote.periodStart, $lte: ultimoLote.periodEnd },
        })
        .sort({ date: 1, _id: 1 })
        .session(session)
        .exec();

      if (asientos.length === 0) {
        throw new ConflictException(
          'No hay movimientos nuevos por adicionar en el período actual.',
        );
      }

      const anchorMap = await this.buildAnchorMap(
        asientos,
        coPropertyId,
        session,
      );
      const comprobantePorClave = await this.resolveComprobantes(
        asientos,
        anchorMap,
        coPropertyId,
        session,
      );

      const consecutivo = await this.consecutivosLote
        .findOneAndUpdate(
          { coPropertyId },
          { $inc: { nextNumber: 1 } },
          { returnDocument: 'after', upsert: true, session },
        )
        .exec();
      const numeroLote = consecutivo.nextNumber;

      const filasMovmes: FilaMovmes[] = [];
      const filasMovmesdo: FilaMovmesdo[] = [];

      for (const asiento of asientos) {
        const tipoDocumento = tipoDocumentoDe(asiento);
        const anchor = anchorMap.get(resolveAnchorId(asiento).toString());

        filasMovmes.push({
          tipoDocumento,
          numero: anchor?.number ?? 0,
          fecha: asiento.date,
          numeroLote,
          detalle: asiento.entries[0]?.description ?? '',
        });

        const comprobante =
          comprobantePorClave.get(`${tipoDocumento}:${anchor?.prefix ?? ''}`) ??
          null;

        for (const entry of asiento.entries) {
          filasMovmesdo.push({
            cuenta: entry.account,
            centroCosto: entry.centroCosto ?? null,
            tercero: entry.tercero ?? null,
            detalle: entry.description,
            baseGravable: entry.baseGravable ?? null,
            valorDebito: entry.type === 'debito' ? entry.amount : null,
            valorCredito: entry.type === 'credito' ? entry.amount : null,
            comprobante,
            numeroDocCruce: entry.numeroDocumento ?? null,
          });
        }
      }

      const [loteCreado] = await this.lotes.create(
        [
          {
            coPropertyId,
            number: numeroLote,
            periodStart: ultimoLote.periodStart,
            periodEnd: ultimoLote.periodEnd,
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
    coPropertyId: Types.ObjectId,
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
        Model<{ _id: Types.ObjectId; prefix: string; number: number }>,
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
        .find({ _id: { $in: ids }, coPropertyId }, { prefix: 1, number: 1 })
        .session(session)
        .exec();
      for (const doc of docs) {
        map.set(doc._id.toString(), { prefix: doc.prefix, number: doc.number });
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
    coPropertyId: Types.ObjectId,
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
      .find({ coPropertyId, category: { $in: categorias } })
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
