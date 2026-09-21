import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import {
  SaldoDocumentoOrigen,
  SaldoDocumentoOrigenDocument,
} from '../../database/schemas/recibos/saldo-documento-origen.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  CuentaContable,
  CuentaContableDocument,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { fechaNotaCredito } from '../notas-credito/notas-credito.mapper';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import { restaurarSaldoDocumentoOrigen } from '../recibos/cruce.util';
import {
  construirContraAsientoNotaDebito,
  construirMovimientos,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
  type MarcasCuentaContable,
} from '../facturacion/asiento.builder';
import { toNotaDebito, toNotaDebitoDetalle } from './notas-debito.mapper';
import { construirDatosImpresionNotaDebito } from './nota-debito-pdf-datos.util';
import type {
  NotaDebito as NotaDebitoContract,
  NotaDebitoDetalle,
  Paginado,
} from '../../contracts';
import type { CrearNotaDebitoDto } from './dto/crear-nota-debito.dto';
import type { AnularNotaDebitoDto } from './dto/anular-nota-debito.dto';
import type { ListarNotaDebitoDto } from './dto/listar-nota-debito.dto';

/**
 * Service for Nota Débito: manual additional charges against a property's
 * cartera. Architecturally a payable document (like Factura), not a credit
 * source (like Recibo/NotaCredito).
 *
 * `terceros` and `presentacionDocumento` were APPENDED, trailing and
 * optional (same reasoning as `cuentasContables` right above), when
 * `crear()` took over freezing this Nota Débito's own `documentDefinition`
 * into the shared `presentacion_documento` table — see
 * `congelarPresentacionNotaDebito`. `terceros` is needed only for that step
 * (`construirDatosImpresionNotaDebito`'s own `modelos.terceros`); every
 * existing positional test keeps compiling with both left `undefined`, in
 * which case `congelarPresentacionNotaDebito` simply no-ops.
 */
@Injectable()
export class NotasDebitoService {
  private readonly logger = new Logger(NotasDebitoService.name);

  constructor(
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    private readonly tenant: TenantContextService,
    private readonly numeracion: NumeracionService,
    @InjectConnection() private readonly connection: Connection,
    private readonly lotes: LotesFacturacionService,
    @InjectModel(SaldoDocumentoOrigen.name)
    private readonly saldoDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables?: Model<CuentaContableDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros?: Model<TerceroDocument>,
    private readonly presentacionDocumento?: PresentacionDocumentoService,
  ) {}

  /** See `RecibosService.conAuxiliares`'s own docblock — identical shape.
   *  `documentoCruce` is this Nota Débito's own self-reference (ND, its own
   *  número) — a Nota Débito creates a NEW receivable, so unlike a Recibo/
   *  Nota Crédito (which reduce someone else's), its cartera line always
   *  references itself. */
  private async conAuxiliares(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    copropiedad: {
      defaultCostCentre: string | null;
      cashFlowCode: string | null;
    } | null,
    entries: ReturnType<typeof construirMovimientos>,
    documentoCruce?: { tipo: 'FV' | 'ND'; numero: number } | null,
  ): Promise<ReturnType<typeof construirMovimientos>> {
    if (!this.cuentasContables) return entries;
    const [cuentas, inmueble] = await Promise.all([
      this.cuentasContables.find({ coPropertyId }).session(session).exec(),
      this.inmuebles?.findById(inmuebleId).session(session).exec(),
    ]);
    const marcas = new Map<string, MarcasCuentaContable>(
      cuentas.map((c) => [
        c.code,
        {
          requiereTercero: c.requiresTercero,
          centroUtilidad: c.profitCenter,
          centroDestino: c.destinationCenter,
          flujoCaja: c.cashFlow,
          requiereDocumentoCruce: c.requiresCrossDocument,
        },
      ]),
    );
    return enriquecerMovimientosConAuxiliares(entries, marcas, {
      terceroCode: inmueble?.code ?? null,
      centroCosto: copropiedad?.defaultCostCentre ?? null,
      flujoCajaCodigo: copropiedad?.cashFlowCode ?? null,
      documentoCruce: documentoCruce ?? null,
    });
  }

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

  /**
   * Creates a Nota Débito — a single-concepto charge against an inmueble's
   * cartera. The outstandingBalance starts equal to total, and the document
   * is immediately payable via Recibo/NotaCredito application.
   */
  async crear(
    accountId: string,
    dto: CrearNotaDebitoDto,
  ): Promise<NotaDebitoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(dto.inmuebleId);
    const conceptoId = new Types.ObjectId(dto.conceptoId);

    // A refusal costs no session — same placement as
    // RecibosService.crear()'s own periodo/lotes checks.
    await this.lotes.exigirSinLoteAbierto(coPropertyId.toString());

    // The charge's own date must fall within the last consolidated billing
    // run's period — same rule, same reasoning, same helper as
    // `RecibosService.crear()`'s identical check on `fechaRecibo`. A
    // coproperty that has never consolidated a lote has no "current period"
    // yet, so nothing to validate against.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fechaCargo),
      ultimoLote,
      'La fecha de la nota',
    );

    // Validate concepto exists and belongs to this coproperty.
    const concepto = await this.conceptos
      .findOne({ _id: conceptoId, coPropertyId })
      .populate('cuentaCreditoId', 'code')
      .populate('cuentaDebitoId', 'code')
      .exec();
    if (!concepto) {
      throw new NotFoundException(
        `No se encontró el concepto de cobro ${dto.conceptoId}`,
      );
    }

    // A Nota Débito freezes the party it was issued to too, same as every
    // other financial document (schema's own `terceroId` docblock) —
    // resolve the unit's CURRENT titular (`Inmueble.holderId`) into a
    // Tercero reference, same source `LotesFacturacionService` reads for a
    // Factura's own `terceroId`. Also the only place this method verifies
    // `dto.inmuebleId` actually belongs to this coproperty (the tenancy
    // law) before creating anything against it.
    const inmueble = await this.inmuebles
      .findOne({ _id: inmuebleId, coPropertyId })
      .exec();
    if (!inmueble) {
      throw new NotFoundException(
        `No se encontró el inmueble ${dto.inmuebleId}`,
      );
    }
    const terceroId = inmueble.holderId;

    const resultado = await this.transaccion(async (session) => {
      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        dto.codigo,
        session,
      );

      const [creada] = await this.notasDebito.create(
        [
          {
            coPropertyId,
            inmuebleId,
            terceroId,
            conceptoId,
            reason: dto.motivo,
            description: dto.descripcion ?? null,
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            issueDate: new Date(dto.fechaCargo),
            dueDate: new Date(dto.fechaVencimiento),
            total: dto.total,
            outstandingBalance: dto.total,
            status: 'emitida',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      // A Nota Débito is a chargeable document like a Factura line — it must
      // increment SaldoCartera the same way (previously missing entirely:
      // `this.saldos` was injected but never called here, so a ND's charge
      // was invisible to every SaldoCartera-reading report until a later
      // Recibo/NC touched it). Read-before-write so the new
      // CarteraPorDocumento row can freeze `saldoAnterior`/`saldoNuevo`, same
      // fields `LotesFacturacionService.consolidar()` seeds per Factura line.
      const saldoPrevio = await this.saldos
        .findOne({ coPropertyId, inmuebleId, conceptoId })
        .session(session)
        .exec();
      const saldoAnterior = saldoPrevio?.balance ?? 0;

      await this.saldos
        .findOneAndUpdate(
          { coPropertyId, inmuebleId, conceptoId },
          {
            $inc: { balance: dto.total },
            $setOnInsert: { coPropertyId, inmuebleId, conceptoId },
          },
          { session, upsert: true },
        )
        .exec();

      // Seeds this Nota Débito's own atomically-guarded total-balance row —
      // see `SaldoTotalDocumento`'s own docblock.
      await this.saldoTotalDocumento.create(
        [
          {
            coPropertyId,
            tipoDocumento: 'ND' as const,
            documentoId: creada._id,
            total: dto.total,
            saldoPendiente: dto.total,
          },
        ],
        { session },
      );

      // Seeds this Nota Débito's own row in the per-document cartera ledger
      // — see `CarteraPorDocumento`'s own docblock.
      await this.carteraPorDocumento.create(
        [
          {
            coPropertyId,
            inmuebleId,
            tipoDocumento: 'ND' as const,
            documentoId: creada._id,
            conceptoId,
            montoOriginal: dto.total,
            saldoPendiente: dto.total,
            saldoAnterior,
            saldoNuevo: saldoAnterior + dto.total,
          },
        ],
        { session },
      );

      // Post creation journal entry: debit the concepto's own receivable
      // account (cuentaDebitoId), credit its income account (cuentaCreditoId)
      // — same per-concepto accounts a Factura line codes with, per
      // `construirMovimientos`'s own docblock. Falls back to the
      // coproperty's shared `receivablesAccount` only when the concepto has
      // no `cuentaDebitoId` configured (that fallback lives inside
      // `construirMovimientos` itself).
      await this.postearAsientoCreacion(
        session,
        coPropertyId,
        creada,
        codigoDeCuentaContable(concepto.cuentaDebitoId),
        codigoDeCuentaContable(concepto.cuentaCreditoId),
        concepto.kind,
      );

      const final = await this.notasDebito
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      // Just seeded above, still full — no need to re-read SaldoTotalDocumento.
      return toNotaDebito(final!, dto.total, inmueble.code);
    });

    // Frozen presentation record — built once here, outside the transaction
    // above and AFTER it has already committed: this Nota Débito's own
    // financial correctness never depends on this succeeding. Same
    // frozen-at-emission principle `LotesFacturacionService.consolidar()`
    // already applies to Factura, extended to this document (see
    // `congelarPresentacionNotaDebito`).
    await this.congelarPresentacionNotaDebito(
      coPropertyId,
      new Types.ObjectId(resultado.id),
    );

    return resultado;
  }

  /**
   * Freezes this Nota Débito's react-pdf presentation tree into the shared,
   * permanent `presentacion_documento` table — called AFTER `crear()`'s own
   * transaction has already committed (never from inside it). No-ops when
   * any optional dependency it needs is missing (test-only construction —
   * see this class's own docblock). Wrapped in try/catch, log-and-continue,
   * never rethrown — same placement/reasoning as
   * `LotesFacturacionService.consolidar()`'s identical step for Factura.
   */
  private async congelarPresentacionNotaDebito(
    coPropertyId: Types.ObjectId,
    notaId: Types.ObjectId,
  ): Promise<void> {
    if (
      !this.presentacionDocumento ||
      !this.terceros ||
      !this.cuentasContables
    ) {
      return;
    }
    try {
      const [notaRaw, copropiedad] = await Promise.all([
        this.notasDebito.findOne({ _id: notaId, coPropertyId }).exec(),
        this.copropiedades.findById(coPropertyId).exec(),
      ]);
      if (!notaRaw || !copropiedad) return;

      const datos = await construirDatosImpresionNotaDebito(
        notaRaw,
        copropiedad,
        coPropertyId,
        {
          inmuebles: this.inmuebles,
          terceros: this.terceros,
          conceptos: this.conceptos,
          asientos: this.asientos,
          cuentasContables: this.cuentasContables,
        },
      );

      // Deferred import — see `RecibosService.congelarPresentacionRecibo`'s
      // own identical comment: `recibo-pdf.ts` pulls in `@react-pdf/renderer`
      // (ESM), which Jest's CJS environment can't load statically.
      const {
        contenidoRecibo,
      }: typeof import('../../common/pdf/recibo-pdf.js') =
        await import('../../common/pdf/recibo-pdf.js');
      const {
        serializarArbol,
      }: typeof import('../../common/pdf/react/serializar-arbol.js') =
        await import('../../common/pdf/react/serializar-arbol.js');

      await this.presentacionDocumento.guardar(
        'ND',
        notaRaw._id,
        serializarArbol(contenidoRecibo(datos, copropiedad)),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo congelar documentDefinition para la nota débito ${notaId.toString()} — la nota ya quedó creada, se puede reintentar aparte.`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /**
   * Lean listing — always scoped to the active copropiedad, honoring filters.
   * Uses `toNotaDebito`, never `toNotaDebitoDetalle`.
   */
  async findAll(
    query: ListarNotaDebitoDto,
  ): Promise<Paginado<NotaDebitoContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;
    if (query.conSaldoPendiente) {
      // No longer a field on NotaDebito itself — resolve candidate ids from
      // `SaldoTotalDocumento` first (see that schema's own docblock).
      const conSaldo = await this.saldoTotalDocumento
        .find({ coPropertyId, tipoDocumento: 'ND', saldoPendiente: { $gt: 0 } })
        .exec();
      filtro._id = { $in: conSaldo.map((s) => s.documentoId) };
    }
    if (query.fechaDesde || query.fechaHasta) {
      filtro.issueDate = {
        ...(query.fechaDesde ? { $gte: new Date(query.fechaDesde) } : {}),
        ...(query.fechaHasta ? { $lte: new Date(query.fechaHasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.notasDebito
        .find(filtro)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.notasDebito.countDocuments(filtro).exec(),
    ]);

    const saldos = documentos.length
      ? await this.saldoTotalDocumento
          .find({ documentoId: { $in: documentos.map((d) => d._id) } })
          .exec()
      : [];
    const saldoPorDocumento = new Map(
      saldos.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );

    // Batched — one query for the whole page, never one per row.
    const inmuebleIds = [
      ...new Set(documentos.map((d) => d.inmuebleId.toString())),
    ].map((idInmueble) => new Types.ObjectId(idInmueble));
    const inmuebles = inmuebleIds.length
      ? await this.inmuebles
          .find({ coPropertyId, _id: { $in: inmuebleIds } })
          .exec()
      : [];
    const codigoPorInmueble = new Map(
      inmuebles.map((i) => [i._id.toString(), i.code]),
    );

    return {
      items: documentos.map((d) =>
        toNotaDebito(
          d,
          saldoPorDocumento.get(d._id.toString()) ?? 0,
          codigoPorInmueble.get(d.inmuebleId.toString()) ?? '',
        ),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Full detail — includes the `aplicaciones` array via a separate query
   * against `AplicacionCartera`, assembled through `toNotaDebitoDetalle`.
   */
  async findOne(id: string): Promise<NotaDebitoDetalle> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasDebito
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota débito ${id}`);
    }
    const saldoTotal = await this.saldoTotalDocumento
      .findOne({ documentoId: nota._id })
      .exec();
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, documentType: 'ND', documentId: nota._id })
      .sort({ appliedAt: 1 })
      .exec();

    // Each aplicación's source (who paid this nota) can be a different
    // Recibo/Nota Crédito/Nota de Anticipo — batch-resolve their own
    // business dates instead of showing the real cruce instant
    // (`appliedAt`), same reasoning as every other `appliedAt` fix this
    // session.
    const idsPorTipo = {
      RC: [] as string[],
      NC: [] as string[],
      NA: [] as string[],
    };
    for (const a of aplicaciones)
      idsPorTipo[a.sourceType].push(a.sourceId.toString());
    const [recibosOrigen, notasCreditoOrigen, notasAnticipoOrigen] =
      await Promise.all([
        idsPorTipo.RC.length
          ? this.recibos
              .find({ coPropertyId, _id: { $in: idsPorTipo.RC } })
              .exec()
          : [],
        idsPorTipo.NC.length
          ? this.notasCredito
              .find({ coPropertyId, _id: { $in: idsPorTipo.NC } })
              .exec()
          : [],
        idsPorTipo.NA.length
          ? this.notasAnticipo
              .find({ coPropertyId, _id: { $in: idsPorTipo.NA } })
              .exec()
          : [],
      ]);
    const fechasPorSourceId = new Map<string, Date>([
      ...recibosOrigen.map((r): [string, Date] => [
        r._id.toString(),
        r.receivedDate,
      ]),
      ...notasCreditoOrigen.map((nc): [string, Date] => [
        nc._id.toString(),
        fechaNotaCredito(nc),
      ]),
      ...notasAnticipoOrigen.map((na): [string, Date] => [
        na._id.toString(),
        na.issueDate,
      ]),
    ]);

    // Also the frontend's source for rendering this Nota Débito's PDF
    // client-side — frozen once by `congelarPresentacionNotaDebito`, read
    // back the same way `RecibosService.findOne` reads its own
    // `documentDefinition`.
    const documentDefinition = this.presentacionDocumento
      ? await this.presentacionDocumento.buscar('ND', nota._id)
      : null;

    return toNotaDebitoDetalle(
      nota,
      saldoTotal?.saldoPendiente ?? 0,
      aplicaciones,
      await this.resolverInmuebleCodigo(nota.inmuebleId),
      fechasPorSourceId,
      documentDefinition,
    );
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation.
   */
  async findOneRaw(id: string): Promise<NotaDebitoDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasDebito
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota débito ${id}`);
    }
    return nota;
  }

  /**
   * Live-resolves an inmueble's printable código from its id — no frozen
   * field for it exists on `NotaDebito` itself (unlike `Factura.unitCode`),
   * so every reader looks it up here. Same fallback (`?? ''`) as
   * `CarteraPorConceptosService`'s identical live-resolve.
   */
  async resolverInmuebleCodigo(inmuebleId: Types.ObjectId): Promise<string> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmueble = await this.inmuebles
      ?.findOne({ _id: inmuebleId, coPropertyId })
      .exec();
    return inmueble?.code ?? '';
  }

  /**
   * Voids a Nota Débito. Unlike Recibos/NotasCrédito's anular() which
   * reverses applications *they made*, a NotaDébito's anular() restores
   * the SOURCE documents (Recibos or NotasCrédito) that applied money
   * against it — the opposite direction.
   *
   * Edge case: if a paying source was independently voided before this
   * NotaDébito is voided, its AplicacionCartera row is already 'revertida'
   * from that earlier void — step 1's filter finds nothing to restore for
   * it. No double-restoration is possible by construction.
   */
  async anular(
    id: string,
    dto: AnularNotaDebitoDto,
    accountId: string,
  ): Promise<NotaDebitoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // The reversing asiento is dated by the user, never by the server clock
    // — same rule as `crear()`'s own `dto.fecha` check. A refusal costs no
    // session.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la anulación',
    );

    return this.transaccion(async (session) => {
      const nota = await this.notasDebito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota débito ${id}`);
      }
      if (nota.status === 'anulada') {
        throw new ConflictException(
          `La nota débito ${nota.fullNumber} ya está anulada`,
        );
      }

      // Step 1: Find all active applications where this ND is the target.
      const aplicacionesActivas = await this.aplicaciones
        .find({
          coPropertyId,
          documentType: 'ND',
          documentId: nota._id,
          status: 'activa',
        })
        .session(session)
        .exec();

      // Step 2: For each, revert the application and restore the source.
      for (const aplicacion of aplicacionesActivas) {
        await this.restaurarMontoFuente(session, coPropertyId, aplicacion);

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, coPropertyId },
            { $set: { status: 'revertida', revertedAt: new Date() } },
            { session },
          )
          .exec();
      }

      // Step 3: Post ONE consolidated reversing journal entry.
      const [copropiedad, concepto] = await Promise.all([
        this.copropiedades.findById(coPropertyId).session(session).exec(),
        this.conceptos
          .findOne({ _id: nota.conceptoId, coPropertyId })
          .populate('cuentaCreditoId', 'code')
          .session(session)
          .exec(),
      ]);
      const cuentaCartera =
        copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
      // Reverses the SAME income account `postearAsientoCreacion` credited
      // (the concepto's own `cuentaCreditoId`, per `crear()`'s own comment
      // above) — production bug (2026-09-21): this used to read
      // `copropiedad.debitNotesAccount`, a coproperty-wide field nothing
      // else in this document's own lifecycle writes to, landing on
      // `CUENTA_SIN_ASIGNAR` whenever it was unset regardless of the
      // concepto's real account. Same class of bug `NotasCreditoService`'s
      // own `resolverLineasAncla` already guards against for NC.
      const cuentaIngreso =
        codigoDeCuentaContable(concepto?.cuentaCreditoId) ?? CUENTA_SIN_ASIGNAR;
      // `cuentasOrden` tracks `intereses` (mora) only — a Nota Débito has
      // exactly one concepto for its whole amount, so this is all-or-
      // nothing (never a partial `montoCuentasOrden` like NC/NT need):
      // move the memo pair back only if this ND's own concepto is mora.
      const cuentasOrdenSiAplica =
        concepto?.kind === 'intereses' ? cuentasOrdenDe(copropiedad) : null;
      let entries = construirContraAsientoNotaDebito(
        cuentaCartera,
        cuentaIngreso,
        nota.total,
        cuentasOrdenSiAplica,
      );
      entries = await this.conAuxiliares(
        session,
        coPropertyId,
        nota.inmuebleId,
        copropiedad,
        entries,
        { tipo: 'ND', numero: nota.number },
      );
      await this.asientos.create(
        [
          {
            coPropertyId,
            loteId: null,
            facturaId: null,
            reciboId: null,
            notaCreditoId: null,
            notaDebitoId: nota._id,
            // The date the user declared for THIS anulación (validated
            // above, before the transaction opened) — never `new Date()`.
            // `voidedAt` stays the real audit instant, a separate field on
            // purpose (see the creation entry's own note on this split).
            date: new Date(dto.fecha),
            entries,
          },
        ],
        { session },
      );

      // Step 4: reverse this ND's own SaldoCartera/CarteraPorDocumento
      // contribution. `restaurarMontoFuente` above only restores the PAYER's
      // side (Recibo/NotaCredito/NotaAnticipo) — that money becomes free to
      // apply elsewhere, it does NOT come back to this concepto, because this
      // concepto's charge no longer exists once voided. So the net cartera
      // effect to remove is exactly this ND's CURRENT pending balance
      // (whatever is STILL pending right now, before it gets forced to 0
      // below) — not `nota.total`: the portion already paid off left this
      // concepto's balance for good the moment it was applied, same
      // reasoning `decrementarSaldoNotaDebito`'s own docblock gives for
      // never restoring on a stale guard failure. No longer a field on the
      // (now immutable) `nota` document itself — resolved fresh from
      // `SaldoTotalDocumento`, same live source `decrementarSaldoNotaDebito`
      // itself reads/writes.
      const saldoActual = await this.saldoTotalDocumento
        .findOne({ documentoId: nota._id })
        .session(session)
        .exec();
      const saldoPendienteActual = saldoActual?.saldoPendiente ?? 0;
      if (saldoPendienteActual > 0) {
        await this.saldos
          .findOneAndUpdate(
            {
              coPropertyId,
              inmuebleId: nota.inmuebleId,
              conceptoId: nota.conceptoId,
            },
            [
              {
                $set: {
                  balance: {
                    $max: [0, { $add: ['$balance', -saldoPendienteActual] }],
                  },
                },
              },
            ],
            { session, updatePipeline: true },
          )
          .exec();
      }
      await this.carteraPorDocumento
        .updateOne(
          { documentoId: nota._id, conceptoId: nota.conceptoId },
          { $set: { saldoPendiente: 0 } },
          { session },
        )
        .exec();
      await this.saldoTotalDocumento
        .updateOne(
          { documentoId: nota._id },
          { $set: { saldoPendiente: 0 } },
          { session },
        )
        .exec();

      // Step 5: Update the Nota Débito's own status.
      await this.notasDebito
        .findOneAndUpdate(
          { _id: id, coPropertyId },
          {
            $set: {
              status: 'anulada',
              outstandingBalance: 0,
              voidedReason: dto.motivo,
              voidedDetail: dto.detalle,
              voidedAt: new Date(),
              voidedBy: accountId,
            },
          },
          { session },
        )
        .exec();

      const final = await this.notasDebito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      // Just forced to 0 above (Step 4).
      return toNotaDebito(
        final!,
        0,
        await this.resolverInmuebleCodigo(final!.inmuebleId),
      );
    });
  }

  /**
   * Restores the source document's unappliedAmount when voiding a Nota
   * Débito application. The source is a Recibo, a Nota Crédito, or a Nota
   * de Anticipo — dispatched by `aplicacion.sourceType`.
   *
   * A Nota de Anticipo has no `unappliedAmount` of its own (see its schema
   * docblock) — undoing one of its applications reduces ITS OWN
   * `appliedAmount` (this document applied less than it thought) and gives
   * the money back to the RECIBO it drew from, exactly like voiding the
   * Nota de Anticipo directly would.
   */
  private async restaurarMontoFuente(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    aplicacion: AplicacionCarteraDocument,
  ): Promise<void> {
    if (aplicacion.sourceType === 'RC') {
      // Live source of `unappliedAmount`/`appliedAmount` is
      // `SaldoDocumentoOrigen` now — the Recibo itself is immutable once
      // issued (see that schema's own docblock).
      await restaurarSaldoDocumentoOrigen(
        this.saldoDocumentoOrigen,
        session,
        aplicacion.sourceId,
        aplicacion.amountApplied,
      );
    } else if (aplicacion.sourceType === 'NC') {
      await restaurarSaldoDocumentoOrigen(
        this.saldoDocumentoOrigen,
        session,
        aplicacion.sourceId,
        aplicacion.amountApplied,
      );
    } else if (aplicacion.sourceType === 'NA') {
      const notaAnticipo = await this.notasAnticipo
        .findOneAndUpdate(
          { _id: aplicacion.sourceId, coPropertyId },
          { $inc: { appliedAmount: -aplicacion.amountApplied } },
          { session },
        )
        .exec();
      if (notaAnticipo) {
        await restaurarSaldoDocumentoOrigen(
          this.saldoDocumentoOrigen,
          session,
          notaAnticipo.reciboOrigenId,
          aplicacion.amountApplied,
        );
      }
    }
  }

  /**
   * Posts the CREATION-time journal entry: debit `cuentaCartera` for the
   * total, credit `cuentaIngreso` for the total. Reuses `construirMovimientos`
   * with a single-line shape built from the conceptoId.
   *
   * `conceptoKind` sets that synthetic line's own `conceptKind` — without it,
   * `construirMovimientos`'s own `usaCuentasOrden` check (`linea.conceptKind
   * === 'intereses'`) always reads `undefined`, so `cuentasOrden` NEVER
   * moved even for a Nota Débito genuinely charging mora (the opposite
   * failure from Notas Contables/Crédito, which moved it unconditionally —
   * here it silently never did).
   */
  private async postearAsientoCreacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaDebitoDocument,
    cuentaDebito: string | null,
    cuentaIngreso: string | null,
    conceptoKind: 'administracion' | 'intereses' | 'otro',
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const incomeAccount = cuentaIngreso ?? CUENTA_SIN_ASIGNAR;

    let entries = construirMovimientos(
      {
        total: nota.total,
        lines: [
          {
            accountingReceivableAccount: cuentaDebito,
            accountingIncomeAccount: incomeAccount,
            totalAmount: nota.total,
            conceptKind: conceptoKind,
          },
        ],
      },
      cuentaCartera,
      cuentasOrdenDe(copropiedad),
    );
    entries = await this.conAuxiliares(
      session,
      coPropertyId,
      nota.inmuebleId,
      copropiedad,
      entries,
      { tipo: 'ND', numero: nota.number },
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: null,
          notaCreditoId: null,
          notaDebitoId: nota._id,
          // The nota's own declared business date (`dto.fechaCargo`), not
          // the real instant of posting — same reasoning as Factura's
          // `lote.billingDate`/Recibo's `receivedDate`: this document can be
          // keyed in days after the date it actually charges.
          date: nota.issueDate,
          entries,
        },
      ],
      { session },
    );
  }
}
