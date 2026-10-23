import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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
  SaldoInicialAnticipo,
  SaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { documentoCruceDeMovimiento } from '../saldos-iniciales/saldo-inicial-cruce.util';
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
  ArchivosLoteContabilidad,
  LoteContabilidad as LoteContabilidadContract,
  RespuestaAdicionContabilidad,
} from '../../contracts';
import {
  ResolucionDocumentosService,
  detalleDeAsiento,
  tipoDocumentoDe,
  type AnchorInfo,
  type TipoDocumentoExport,
} from './resolucion-documentos.service';
import { resolverCodigosDesdeTabla } from '../../common/documentos/titulo-documento.service';

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

/** Who is acting, for the audit log. */
export type ActorAdicion = { accountId: string; nombre: string };

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
    // APPENDED LAST, optional, same convention as the sibling services: only
    // the Nota de Anticipo concept reads it (an anticipo drawn from an
    // opening balance has no Recibo to compose its detail from), and the
    // positional-mock tests that predate Saldos Iniciales de Anticipo stop
    // their argument list before it.
    @InjectModel(SaldoInicialAnticipo.name)
    private readonly saldosInicialesAnticipo?: Model<SaldoInicialAnticipoDocument>,
    // APPENDED after `saldosInicialesAnticipo` for the same reason: the
    // "número doc cruce" column of a payment applied to a Saldo Inicial must
    // be the original document number, resolved at export time.
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales?: Model<SaldoInicialDocument>,
    // APPENDED last, optional, same convention: generating and desmarcando a
    // lote are written to the platform audit log, labelled with the
    // coproperty (the log spans every building).
    @InjectModel(Copropiedad.name)
    private readonly copropiedades?: Model<CopropiedadDocument>,
    private readonly auditoria?: AuditoriaService,
  ) {
    // Built from this service's own models rather than injected, so the
    // positional constructor (and every test written against it) stays
    // exactly as it was when the resolution lived here.
    this.resolucion = new ResolucionDocumentosService(
      facturas,
      recibos,
      notasCredito,
      notasDebito,
      notasContables,
      notasAnticipo,
      saldosInicialesAnticipo,
      saldosIniciales,
    );
  }

  /** Anchor/concepto/saldo-inicial resolution shared with the Comptable
   *  push — see `ResolucionDocumentosService`. */
  private readonly resolucion: ResolucionDocumentosService;

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
   * Entries released by `desmarcar` are picked up too, whatever their date.
   */
  async generar(actor: ActorAdicion): Promise<RespuestaAdicionContabilidad> {
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
          $or: [
            {
              fecha: {
                $gte: ultimoLote.periodoDesde,
                $lte: ultimoLote.periodoHasta,
              },
            },
            { contabilidadLoteDesmarcadoId: { $ne: null } },
          ],
        })
        .sort({ fecha: 1, _id: 1 })
        .session(session)
        .exec();

      if (asientos.length === 0) {
        throw new ConflictException(
          'No hay movimientos nuevos por adicionar en el período actual.',
        );
      }

      const consecutivo = await this.consecutivosLote
        .findOneAndUpdate(
          { copropiedadId },
          { $inc: { nextNumber: 1 } },
          { returnDocument: 'after', upsert: true, session },
        )
        .exec();
      const numeroLote = consecutivo.nextNumber;

      const archivos = await this.construirArchivos(
        asientos,
        numeroLote,
        copropiedadId,
        session,
      );

      const [loteCreado] = await this.lotes.create(
        [
          {
            copropiedadId,
            number: numeroLote,
            periodStart: ultimoLote.periodoDesde,
            periodEnd: ultimoLote.periodoHasta,
            totalAsientos: asientos.length,
            generatedBy: actor.accountId,
          },
        ],
        { session },
      );

      await this.asientos.updateMany(
        { _id: { $in: asientos.map((a) => a._id) } },
        { $set: { contabilidadLoteId: loteCreado._id } },
        { session },
      );

      await this.registrarAuditoria(
        actor,
        'crear',
        loteCreado._id,
        `generado: ${asientos.length} ${asientos.length === 1 ? 'documento' : 'documentos'}`,
        numeroLote,
        copropiedadId,
        session,
      );

      return {
        lote: toLoteContabilidad(loteCreado),
        ...archivos,
      };
    });
  }

  /**
   * Rebuilds a past lote's two files from the entries it stamped — the way
   * back when a download never reached the accountant (a browser can block
   * the second of two automatic downloads). Built from each document's
   * current data, so a concepto edited since then shows its new text.
   */
  async archivos(loteId: string): Promise<ArchivosLoteContabilidad> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const lote = await this.buscarLote(loteId, copropiedadId);
    if (lote.estado === 'desmarcado') {
      throw new ConflictException(
        `El lote ${lote.number} fue desmarcado: sus movimientos se adicionan en el próximo lote que generes.`,
      );
    }

    const asientos = await this.asientos
      .find({ copropiedadId, contabilidadLoteId: lote._id })
      .sort({ fecha: 1, _id: 1 })
      .exec();
    return this.construirArchivos(asientos, lote.number, copropiedadId, null);
  }

  /**
   * "Desmarca" a lote: releases every entry it stamped so the next
   * generation exports them again under a new lote number. The lote itself
   * is kept as history (`estado: 'desmarcado'`, who and when), never
   * deleted. Conditional on the lote still being `generado`, so two
   * concurrent clicks release it once.
   */
  async desmarcar(
    loteId: string,
    actor: ActorAdicion,
  ): Promise<LoteContabilidadContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const lote = await this.buscarLote(loteId, copropiedadId);
    if (lote.estado === 'desmarcado') {
      throw new ConflictException(`El lote ${lote.number} ya fue desmarcado.`);
    }

    return this.transaccion(async (session) => {
      const actualizado = await this.lotes
        .findOneAndUpdate(
          { _id: lote._id, copropiedadId, estado: { $ne: 'desmarcado' } },
          {
            $set: {
              estado: 'desmarcado',
              fechaDesmarcado: new Date(),
              desmarcadoPor: new Types.ObjectId(actor.accountId),
            },
          },
          { returnDocument: 'after', session },
        )
        .exec();
      if (!actualizado) {
        throw new ConflictException(
          `El lote ${lote.number} ya fue desmarcado.`,
        );
      }

      await this.asientos.updateMany(
        { copropiedadId, contabilidadLoteId: lote._id },
        {
          $set: {
            contabilidadLoteId: null,
            contabilidadLoteDesmarcadoId: lote._id,
          },
        },
        { session },
      );

      await this.registrarAuditoria(
        actor,
        'desmarcar',
        lote._id,
        `desmarcado: ${lote.totalAsientos} ${lote.totalAsientos === 1 ? 'documento vuelve' : 'documentos vuelven'} a pendientes`,
        lote.number,
        copropiedadId,
        session,
      );

      return toLoteContabilidad(actualizado);
    });
  }

  /** Writes the platform audit entry inside the operation's own
   *  transaction: if the log write fails, the generation/desmarque rolls
   *  back too, so nothing happens unrecorded. */
  private async registrarAuditoria(
    actor: ActorAdicion,
    accion: 'crear' | 'desmarcar',
    loteId: Types.ObjectId,
    detalle: string,
    numeroLote: number,
    copropiedadId: Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    if (!this.auditoria) return;
    const copropiedad = this.copropiedades
      ? await this.copropiedades.findById(copropiedadId).session(session).exec()
      : null;
    const etiquetaCopropiedad =
      [copropiedad?.codigo, copropiedad?.nombre].filter(Boolean).join(' ') ||
      copropiedadId.toString();
    await this.auditoria.registrar(
      {
        actorAccountId: actor.accountId,
        actorNombre: actor.nombre,
        accion,
        entidadTipo: 'lote-contabilidad',
        entidadId: loteId.toString(),
        entidadEtiqueta: `Lote ${numeroLote} de Adición a Contabilidad de ${etiquetaCopropiedad} ${detalle}`,
      },
      session,
    );
  }

  /** Tenant-scoped lookup — never `findById` (see the tenancy law). */
  private async buscarLote(
    loteId: string,
    copropiedadId: Types.ObjectId,
  ): Promise<LoteContabilidadDocument> {
    const lote = Types.ObjectId.isValid(loteId)
      ? await this.lotes
          .findOne({ _id: new Types.ObjectId(loteId), copropiedadId })
          .exec()
      : null;
    if (!lote) {
      throw new NotFoundException('No existe ese lote de contabilidad.');
    }
    return lote;
  }

  /** Builds both CSV files for a set of entries under one lote number —
   *  shared by a new generation and a past lote's re-download. `session`
   *  is null outside a transaction. */
  private async construirArchivos(
    asientos: AsientoContableDocument[],
    numeroLote: number,
    copropiedadId: Types.ObjectId,
    session: ClientSession | null,
  ): Promise<ArchivosLoteContabilidad> {
    const anchorMap = await this.resolucion.buildAnchorMap(
      asientos,
      copropiedadId,
      session,
    );
    const conceptoMap = await this.resolucion.resolveConceptos(
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

    const saldosInicialesPorNumero =
      await this.resolucion.resolverSaldosIniciales(
        asientos,
        copropiedadId,
        session,
      );

    // The tipo exported is the coproperty's own código from its Tabla de
    // Documentos — never the internal key (`tipoDocumentoDe`), which only
    // picks the comprobante row below.
    const codigoDe = resolverCodigosDesdeTabla(
      await this.consecutivosDocumento
        .find({ copropiedadId })
        .session(session)
        .exec(),
    );

    const filasMovmes: FilaMovmes[] = [];
    const filasMovmesdo: FilaMovmesdo[] = [];

    for (const asiento of asientos) {
      const clave = tipoDocumentoDe(asiento);
      const anchorIdStr = resolveAnchorId(asiento).toString();
      const anchor = anchorMap.get(anchorIdStr);
      const tipoDocumento = codigoDe(clave, anchor?.prefix ?? '');
      // The document's own concepto (see `detalleDeAsiento`).
      const detalle = detalleDeAsiento(asiento, conceptoMap);

      filasMovmes.push({
        tipoDocumento,
        numero: anchor?.number ?? 0,
        fecha: asiento.fecha,
        numeroLote,
        detalle,
      });

      const comprobante =
        comprobantePorClave.get(`${clave}:${anchor?.prefix ?? ''}`) ?? null;

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
          // A Saldo Inicial movimiento stores only the internal ordinal;
          // export the original document number (e.g. 2941). Free text
          // there, so the column carries a string.
          numeroDocCruce:
            documentoCruceDeMovimiento(entry, saldosInicialesPorNumero)
              ?.numero ?? null,
        });
      }
    }

    return {
      movmes: construirMovmes(filasMovmes),
      movmesdo: construirMovmesdo(filasMovmesdo),
    };
  }

  /** Batch-resolves "comprobante" (`ConsecutivoDocumento.comprobanteContable`)
   *  per (tipoDocumento, prefix) pair actually present in this batch — a
   *  document itself only remembers its `prefix`, never which specific
   *  código it was numbered under, so this matches back to the
   *  ConsecutivoDocumento row sharing that category+prefix. FV and NA never
   *  have one (see `categoriaDe`'s own docblock) and are skipped. */
  private async resolveComprobantes(
    asientos: AsientoContableDocument[],
    anchorMap: Map<string, AnchorInfo>,
    copropiedadId: Types.ObjectId,
    session: ClientSession | null,
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
      .find({ copropiedadId, categoria: { $in: categorias } })
      .session(session)
      .exec();

    for (const clave of claves) {
      const [tipo, prefix, categoria] = clave.split(':');
      const consecutivo = consecutivos.find(
        (c) => c.categoria === categoria && c.prefijo === prefix,
      );
      map.set(`${tipo}:${prefix}`, consecutivo?.comprobanteContable ?? null);
    }
    return map;
  }
}
