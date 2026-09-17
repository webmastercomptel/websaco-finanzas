import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  NotaAnticipo,
  NotaAnticipoDocument,
} from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
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
  Movimiento,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
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
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  actualizarRemanentesLinea,
  ajustarSaldosCarteraPorDistribucion,
  ejecutarAplicacionFifo,
  ejecutarAplicacionManual,
  remanentesPorLinea,
  restaurarSaldoDocumentoOrigen,
  restaurarSaldoTotalDocumento,
  type DesgloseCarteraAplicacion,
} from '../recibos/cruce.util';
import {
  construirContraAsientoAplicacionAnticipo,
  construirMovimientosAplicacionAnticipo,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
  type MarcasCuentaContable,
} from '../facturacion/asiento.builder';
import { toNotaAnticipo, toNotaAnticipoDetalle } from './notas-anticipo.mapper';
import { construirDatosImpresionNotaAnticipo } from './nota-anticipo-pdf-datos.util';
import type {
  NotaAnticipo as NotaAnticipoContract,
  NotaAnticipoDetalle,
  Paginado,
} from '../../contracts';
import type { CrearNotaAnticipoDto } from './dto/crear-nota-anticipo.dto';
import type { AnularNotaAnticipoDto } from './dto/anular-nota-anticipo.dto';
import type { ListarNotaAnticipoDto } from './dto/listar-nota-anticipo.dto';

/**
 * Applies a Recibo's leftover `unappliedAmount` against open cartera LATER,
 * as its own auditable document (Anticipos module) — the replacement for
 * the removed `POST /recibos/:id/aplicar` (see `RecibosController`'s own
 * docblock on why that route no longer exists). One Recibo can have many
 * Notas de Anticipo over time, each drawing the balance down further.
 *
 * `terceros` was APPENDED, trailing and optional (same reasoning as
 * `cuentasContables`/`inmuebles` right above), alongside
 * `presentacionDocumento`, when `crear()` took over freezing this Nota de
 * Anticipo's own `documentDefinition` into the shared
 * `presentacion_documento` table — see `congelarPresentacionNotaAnticipo`.
 * Every existing positional test keeps compiling with both left
 * `undefined`, in which case that step simply no-ops.
 */
@Injectable()
export class NotasAnticipoService {
  private readonly logger = new Logger(NotasAnticipoService.name);

  constructor(
    @InjectModel(NotaAnticipo.name)
    private readonly notasAnticipo: Model<NotaAnticipoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
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
    private readonly tenant: TenantContextService,
    private readonly numeracion: NumeracionService,
    @InjectConnection() private readonly connection: Connection,
    private readonly lotes: LotesFacturacionService,
    @InjectModel(SaldoDocumentoOrigen.name)
    private readonly saldoDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables?: Model<CuentaContableDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles?: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros?: Model<TerceroDocument>,
    private readonly presentacionDocumento?: PresentacionDocumentoService,
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

  /** See `RecibosService.conAuxiliares`'s own docblock — identical shape. */
  private async conAuxiliares(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    copropiedad: {
      defaultCostCentre: string | null;
      cashFlowCode: string | null;
    } | null,
    entries: Movimiento[],
  ): Promise<Movimiento[]> {
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
    });
  }

  /**
   * Creates a Nota de Anticipo: draws (part of) a Recibo's
   * `unappliedAmount`, applies it FIFO or manually against that Recibo's
   * own inmueble's open cartera, and posts ONE journal entry — debit
   * `cuentaAnticipos` (one line, the total this document applied), credit
   * each cargo's own account (`desgloseCartera`), anchored by
   * `notaAnticipoId` instead of `reciboId`.
   */
  async crear(
    accountId: string,
    dto: CrearNotaAnticipoDto,
  ): Promise<NotaAnticipoContract> {
    if (dto.aplicaciones?.length && dto.aplicacionAutomatica) {
      throw new BadRequestException(
        'No se puede pedir aplicación manual y automática a la vez',
      );
    }
    if (!dto.aplicaciones?.length && !dto.aplicacionAutomatica) {
      throw new BadRequestException(
        'Debe indicar aplicaciones manuales o aplicación automática',
      );
    }

    const coPropertyId = this.tenant.resolveCoPropertyId();

    // A refusal costs no session — same placement/reasoning as
    // RecibosService.crear()'s own check: SaldoCartera and every Factura's
    // outstandingBalance can still move while a billing run is open, so a
    // Nota de Anticipo applied mid-run could cross against numbers about to
    // change.
    await this.lotes.exigirSinLoteAbierto(coPropertyId.toString());

    // The document's own date must fall within the last consolidated
    // billing run's period — same rule, same reasoning, same helper as
    // `RecibosService.crear()`'s identical check on `fechaRecibo`. A
    // coproperty that has never consolidated a lote has no "current period"
    // yet, so nothing to validate against.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fechaEmision),
      ultimoLote,
      'La fecha de la nota',
    );

    const resultado = await this.transaccion(async (session) => {
      const reciboDoc = await this.recibos
        .findOne({
          _id: dto.reciboOrigenId,
          coPropertyId,
          status: 'activo',
        })
        .session(session)
        .exec();
      if (!reciboDoc) {
        throw new NotFoundException(
          `No se encontró el recibo ${dto.reciboOrigenId}`,
        );
      }
      // `unappliedAmount` is no longer a live field on the (now immutable)
      // Recibo — merged in fresh from `SaldoDocumentoOrigen`, same pattern
      // `decrementarSaldoFactura` uses for its own return value. This Recibo
      // may have already been drawn down by an earlier Nota de Anticipo, so
      // the frozen field alone would always read as "fully available".
      const saldoOrigen = await this.saldoDocumentoOrigen
        .findOne({ documentoId: reciboDoc._id })
        .session(session)
        .exec();
      const recibo = Object.assign(reciboDoc, {
        unappliedAmount: saldoOrigen?.saldoDisponible ?? 0,
      });
      if (recibo.unappliedAmount <= 0) {
        throw new ConflictException(
          `El recibo ${recibo.fullNumber} no tiene anticipo pendiente por aplicar`,
        );
      }

      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        dto.codigo,
        session,
      );

      const fechaEmision = new Date(dto.fechaEmision);

      const [creada] = await this.notasAnticipo.create(
        [
          {
            coPropertyId,
            inmuebleId: recibo.inmuebleId,
            terceroId: recibo.terceroId,
            reciboOrigenId: recibo._id,
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            issueDate: fechaEmision,
            appliedAmount: 0,
            status: 'activo',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      const ctx = {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        aplicaciones: this.aplicaciones,
        saldos: this.saldos,
        carteraPorDocumento: this.carteraPorDocumento,
        saldoTotalDocumento: this.saldoTotalDocumento,
        saldoDocumentoOrigen: this.saldoDocumentoOrigen,
        recibos: this.recibos,
        session,
        coPropertyId,
        recibo,
        sourceType: 'NA' as const,
        sourceId: creada._id,
        // The Nota de Anticipo's OWN declared date — never the original
        // recibo's `receivedDate`, which can be much earlier: this document
        // is applying the leftover LATER, as its own separately dated event
        // (see `ContextoAplicacion.sourceDate`'s own docblock).
        sourceDate: fechaEmision,
        accountId,
      };

      const { totalAplicado, desglose, montoAplicadoMora } = dto.aplicaciones
        ?.length
        ? await (async () => {
            const resultado = await ejecutarAplicacionManual(
              ctx,
              dto.aplicaciones!,
            );
            return {
              totalAplicado: resultado.creadas.reduce(
                (acc, a) => acc + a.amountApplied,
                0,
              ),
              desglose: resultado.desglose,
              montoAplicadoMora: resultado.montoAplicadoMora,
            };
          })()
        : await (async () => {
            const resultado = await ejecutarAplicacionFifo(
              ctx,
              recibo.unappliedAmount,
            );
            return {
              totalAplicado: resultado.aplicadas.reduce(
                (acc, a) => acc + a.amountApplied,
                0,
              ),
              desglose: resultado.desglose,
              montoAplicadoMora: resultado.montoAplicadoMora,
            };
          })();

      // Nothing to apply (e.g. FIFO found no open cartera for this
      // inmueble) — refuse rather than leave a zero-amount document sitting
      // in the ledger with no effect.
      if (totalAplicado === 0) {
        throw new ConflictException(
          `No hay cartera abierta contra la cual aplicar el anticipo del recibo ${recibo.fullNumber}`,
        );
      }

      await this.notasAnticipo
        .findOneAndUpdate(
          { _id: creada._id, coPropertyId },
          { $set: { appliedAmount: totalAplicado } },
          { session },
        )
        .exec();

      await this.postearAsientoCreacion(
        session,
        coPropertyId,
        { _id: creada._id, inmuebleId: recibo.inmuebleId },
        fechaEmision,
        totalAplicado,
        desglose,
        montoAplicadoMora,
      );

      const final = await this.notasAnticipo
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaAnticipo(final!);
    });

    // Frozen presentation record — built once here, outside the transaction
    // above and AFTER it has already committed: this Nota de Anticipo's own
    // financial correctness never depends on this succeeding. Same
    // frozen-at-emission principle `LotesFacturacionService.consolidar()`
    // already applies to Factura, extended to this document (see
    // `congelarPresentacionNotaAnticipo`).
    await this.congelarPresentacionNotaAnticipo(
      coPropertyId,
      new Types.ObjectId(resultado.id),
    );

    return resultado;
  }

  /**
   * Freezes this Nota de Anticipo's react-pdf presentation tree into the
   * shared, permanent `presentacion_documento` table — called AFTER
   * `crear()`'s own transaction has already committed (never from inside
   * it). No-ops when any optional dependency it needs is missing (test-only
   * construction — see this class's own docblock). Wrapped in try/catch,
   * log-and-continue, never rethrown — same placement/reasoning as
   * `LotesFacturacionService.consolidar()`'s identical step for Factura.
   */
  private async congelarPresentacionNotaAnticipo(
    coPropertyId: Types.ObjectId,
    notaId: Types.ObjectId,
  ): Promise<void> {
    if (
      !this.presentacionDocumento ||
      !this.inmuebles ||
      !this.terceros ||
      !this.cuentasContables
    ) {
      return;
    }
    try {
      const [notaRaw, aplicacionesActivas, copropiedad] = await Promise.all([
        this.notasAnticipo.findOne({ _id: notaId, coPropertyId }).exec(),
        this.aplicaciones
          .find({
            coPropertyId,
            sourceType: 'NA',
            sourceId: notaId,
            status: 'activa',
          })
          .sort({ appliedAt: 1 })
          .exec(),
        this.copropiedades.findById(coPropertyId).exec(),
      ]);
      if (!notaRaw || !copropiedad) return;

      const datos = await construirDatosImpresionNotaAnticipo(
        notaRaw,
        aplicacionesActivas,
        copropiedad,
        coPropertyId,
        {
          facturas: this.facturas,
          notasDebito: this.notasDebito,
          recibos: this.recibos,
          inmuebles: this.inmuebles,
          terceros: this.terceros,
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
        'NA',
        notaRaw._id,
        serializarArbol(contenidoRecibo(datos, copropiedad)),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo congelar documentDefinition para la nota de anticipo ${notaId.toString()} — la nota ya quedó creada, se puede reintentar aparte.`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** Lean listing — mirrors `NotasDebitoService.findAll`. */
  async findAll(
    query: ListarNotaAnticipoDto,
  ): Promise<Paginado<NotaAnticipoContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.reciboOrigenId) filtro.reciboOrigenId = query.reciboOrigenId;
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.notasAnticipo
        .find(filtro)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.notasAnticipo.countDocuments(filtro).exec(),
    ]);

    // Never a bare `.map(toNotaAnticipo)` — `Array.map` would leak its own
    // `index` into `toNotaAnticipo`'s second (`documentDefinition`) param,
    // same gotcha `toAplicacionCartera`'s own docblock already warns about.
    return {
      items: documentos.map((doc) => toNotaAnticipo(doc)),
      total,
      pagina,
      porPagina,
    };
  }

  /** Full detail, cargo por cargo — mirrors `RecibosService.findOne`. */
  async findOne(id: string): Promise<NotaAnticipoDetalle> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasAnticipo
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota de anticipo ${id}`);
    }
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, sourceType: 'NA', sourceId: nota._id })
      .sort({ appliedAt: 1 })
      .exec();

    const facturaIds = aplicaciones
      .filter((a) => a.documentType === 'FV')
      .map((a) => a.documentId);
    const notaDebitoIds = aplicaciones
      .filter((a) => a.documentType === 'ND')
      .map((a) => a.documentId);
    const [facturasDoc, notasDebitoDoc] = await Promise.all([
      facturaIds.length
        ? this.facturas.find({ coPropertyId, _id: { $in: facturaIds } }).exec()
        : [],
      notaDebitoIds.length
        ? this.notasDebito
            .find({ coPropertyId, _id: { $in: notaDebitoIds } })
            .exec()
        : [],
    ]);
    const numerosPorDocumento = new Map<string, string>();
    for (const f of facturasDoc)
      numerosPorDocumento.set(f._id.toString(), f.fullNumber);
    for (const nd of notasDebitoDoc)
      numerosPorDocumento.set(nd._id.toString(), nd.fullNumber);

    // Also the frontend's source for rendering this Nota de Anticipo's PDF
    // client-side — frozen once by `congelarPresentacionNotaAnticipo`, read
    // back the same way `RecibosService.findOne` reads its own
    // `documentDefinition`.
    const documentDefinition = this.presentacionDocumento
      ? await this.presentacionDocumento.buscar('NA', nota._id)
      : null;

    return toNotaAnticipoDetalle(
      nota,
      aplicaciones,
      numerosPorDocumento,
      documentDefinition,
    );
  }

  /**
   * Voids a Nota de Anticipo: reverses every active application it made,
   * restoring each target's outstanding balance, and gives the amount BACK
   * to the Recibo it was drawn from — exactly undoing what `crear()` did,
   * never touching the Recibo's original `destinationAccount`/bank leg.
   */
  async anular(
    id: string,
    dto: AnularNotaAnticipoDto,
    accountId: string,
  ): Promise<NotaAnticipoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // The reversing asiento is dated by the user, never by the server clock
    // — same rule Recibos/Notas Crédito apply to their own anulación. A
    // refusal costs no session.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la anulación',
    );

    return this.transaccion(async (session) => {
      const nota = await this.notasAnticipo
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota de anticipo ${id}`);
      }
      if (nota.status === 'anulado') {
        throw new ConflictException(
          `La nota de anticipo ${nota.fullNumber} ya está anulada`,
        );
      }

      const aplicacionesActivas = await this.aplicaciones
        .find({
          coPropertyId,
          sourceType: 'NA',
          sourceId: nota._id,
          status: 'activa',
        })
        .session(session)
        .exec();

      const desglose: DesgloseCarteraAplicacion[] = [];
      let montoAplicadoMora = 0;

      for (const aplicacion of aplicacionesActivas) {
        if (aplicacion.documentType === 'ND') {
          await restaurarSaldoTotalDocumento(
            this.saldoTotalDocumento,
            session,
            aplicacion.documentId,
            aplicacion.amountApplied,
          );
          const notaDebitoDoc = await this.notasDebito
            .findOne({ _id: aplicacion.documentId, coPropertyId })
            .session(session)
            .exec();
          desglose.push({
            cuenta: null,
            monto: aplicacion.amountApplied,
            tipoDocumento: 'ND',
            numeroDocumento: notaDebitoDoc?.number ?? 0,
          });
        } else {
          const facturaDoc = await this.facturas
            .findOne({ _id: aplicacion.documentId, coPropertyId })
            .session(session)
            .exec();

          if (facturaDoc) {
            // Read BEFORE restoring — `remanentesPorLinea` needs the
            // pre-reversal balance for any línea it still has to
            // legacy-derive (a línea already carrying a real
            // `remainingAmount` ignores this and reads its own tracked
            // value regardless).
            const saldoPrevio = await this.saldoTotalDocumento
              .findOne({ documentoId: facturaDoc._id })
              .session(session)
              .exec();
            const factura = Object.assign(facturaDoc, {
              outstandingBalance: saldoPrevio?.saldoPendiente ?? 0,
            });
            // Replays the EXACT split this application recorded
            // (`detalleConceptos`) instead of re-deriving one via the
            // default cascade — same reasoning as `RecibosService.anular()`'s
            // own identical change.
            const remanentesAntes = remanentesPorLinea(factura);
            await restaurarSaldoTotalDocumento(
              this.saldoTotalDocumento,
              session,
              factura._id,
              aplicacion.amountApplied,
            );
            const partes = await ajustarSaldosCarteraPorDistribucion(
              this.saldos,
              this.carteraPorDocumento,
              session,
              coPropertyId,
              factura.inmuebleId,
              aplicacion.detalleConceptos.map((d) => ({
                conceptoId: d.conceptoId,
                monto: d.monto,
              })),
              aplicacion.amountApplied,
              1,
              { tipoDocumento: 'FV', documentoId: factura._id },
            );
            await actualizarRemanentesLinea(
              this.facturas,
              session,
              coPropertyId,
              factura._id,
              partes.map((parte) => ({
                conceptoId: parte.conceptoId,
                nuevoValor:
                  (remanentesAntes.get(parte.conceptoId.toString()) ?? 0) +
                  parte.parte,
              })),
            );
            for (const parte of partes) {
              const linea = factura.lines.find((l) =>
                l.conceptoId.equals(parte.conceptoId),
              );
              if (parte.parte !== 0) {
                desglose.push({
                  cuenta: linea?.accountingReceivableAccount ?? null,
                  monto: parte.parte,
                  tipoDocumento: 'FV',
                  numeroDocumento: factura.number,
                });
              }
              if (linea?.conceptKind === 'intereses') {
                montoAplicadoMora += parte.parte;
              }
            }
          } else {
            desglose.push({
              cuenta: null,
              monto: aplicacion.amountApplied,
              tipoDocumento: 'FV',
              numeroDocumento: 0,
            });
          }
        }

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, coPropertyId },
            { $set: { status: 'revertida', revertedAt: new Date() } },
            { session },
          )
          .exec();
      }

      // Give the money back to the Recibo it was drawn from — the live
      // balance now lives in `SaldoDocumentoOrigen`, not a field on the
      // (immutable) Recibo itself.
      await restaurarSaldoDocumentoOrigen(
        this.saldoDocumentoOrigen,
        session,
        nota.reciboOrigenId,
        nota.appliedAmount,
      );

      const copropiedad = await this.copropiedades
        .findById(coPropertyId)
        .session(session)
        .exec();
      const cuentaCartera =
        copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaAnticipos =
        copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
      const desgloseCartera = desglose.map((d) => ({
        account: d.cuenta ?? cuentaCartera,
        monto: d.monto,
        tipoDocumento: d.tipoDocumento,
        numeroDocumento: d.numeroDocumento,
      }));
      let entries = construirContraAsientoAplicacionAnticipo(
        cuentaAnticipos,
        cuentaCartera,
        nota.appliedAmount,
        'NA',
        desgloseCartera,
        cuentasOrdenDe(copropiedad),
        montoAplicadoMora,
      );
      entries = await this.conAuxiliares(
        session,
        coPropertyId,
        nota.inmuebleId,
        copropiedad,
        entries,
      );
      await this.asientos.create(
        [
          {
            coPropertyId,
            loteId: null,
            facturaId: null,
            reciboId: null,
            notaCreditoId: null,
            notaDebitoId: null,
            notaContableId: null,
            notaAnticipoId: nota._id,
            // The date the user declared for THIS anulación (validated
            // above, before the transaction opened) — never `new Date()`.
            // `voidedAt` stays the real audit instant, a separate field on
            // purpose (same split every other module's anulación now uses).
            date: new Date(dto.fecha),
            entries,
          },
        ],
        { session },
      );

      await this.notasAnticipo
        .findOneAndUpdate(
          { _id: id, coPropertyId },
          {
            $set: {
              status: 'anulado',
              voidedReason: dto.motivo,
              voidedDetail: dto.detalle,
              voidedAt: new Date(),
              voidedBy: accountId,
            },
          },
          { session },
        )
        .exec();

      const final = await this.notasAnticipo
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toNotaAnticipo(final!);
    });
  }

  /**
   * Posts the CREATION-time journal entry — debit `cuentaAnticipos` (one
   * line, the total this document applied), credit each cargo's own
   * account. Reuses `construirMovimientosAplicacionAnticipo`, the exact
   * shape `RecibosService`'s own (now-removed) deferred-apply used to post,
   * anchored by `notaAnticipoId` instead of `reciboId`.
   */
  private async postearAsientoCreacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: { _id: Types.ObjectId; inmuebleId: Types.ObjectId },
    fechaEmision: Date,
    montoAplicado: number,
    desglose: DesgloseCarteraAplicacion[],
    montoAplicadoMora: number,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const desgloseCartera = desglose.map((d) => ({
      account: d.cuenta ?? cuentaCartera,
      monto: d.monto,
      tipoDocumento: d.tipoDocumento,
      numeroDocumento: d.numeroDocumento,
    }));
    let entries = construirMovimientosAplicacionAnticipo(
      cuentaAnticipos,
      cuentaCartera,
      montoAplicado,
      'NA',
      desgloseCartera,
      cuentasOrdenDe(copropiedad),
      montoAplicadoMora,
    );
    entries = await this.conAuxiliares(
      session,
      coPropertyId,
      nota.inmuebleId,
      copropiedad,
      entries,
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: null,
          notaCreditoId: null,
          notaDebitoId: null,
          notaContableId: null,
          notaAnticipoId: nota._id,
          date: fechaEmision,
          entries,
        },
      ],
      { session },
    );
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation, same role
   * `RecibosService`/`NotasCreditoService`'s own `findOneRaw` play.
   */
  async findOneRaw(id: string): Promise<NotaAnticipoDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasAnticipo
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota de anticipo ${id}`);
    }
    return nota;
  }

  /**
   * Active applications this Nota de Anticipo made — used by PDF generation
   * (mirrors `RecibosService.findAplicacionesForSource`).
   */
  async findAplicaciones(id: string): Promise<AplicacionCarteraDocument[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.aplicaciones
      .find({ coPropertyId, sourceType: 'NA', sourceId: id, status: 'activa' })
      .sort({ appliedAt: 1 })
      .exec();
  }
}
