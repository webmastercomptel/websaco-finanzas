import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
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
  CuentaContable,
  CuentaContableDocument,
} from '../../database/schemas/contabilidad/cuenta-contable.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  AplicacionInvalidaError,
  ajustarSaldosCartera,
  ajustarSaldosCarteraPorDistribucion,
  decrementarSaldoDocumentoOrigen,
  decrementarSaldoFactura,
  restaurarSaldoTotalDocumento,
} from '../recibos/cruce.util';
import {
  construirAsientoCruce,
  construirContraAsientoCruce,
  construirMovimientosAplicacionAnticipo,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
  type MarcasCuentaContable,
} from '../facturacion/asiento.builder';
import { validarDistribucionNotaCredito } from './distribucion.util';
import {
  toNotaCredito,
  toNotaCreditoDetalle,
  fechaNotaCredito,
} from './notas-credito.mapper';
import { toAplicacionCartera } from '../recibos/recibos.mapper';
import { toFactura } from '../facturacion/facturas.mapper';
import type {
  NotaCredito as NotaCreditoContract,
  NotaCreditoDetalle,
  Paginado,
  ResultadoAplicacion,
  ErrorAplicacion,
  Factura as FacturaContract,
} from '../../contracts';
import type { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';
import type { AplicarNotaCreditoDto } from './dto/aplicar-nota-credito.dto';
import type { AnularNotaCreditoDto } from './dto/anular-nota-credito.dto';
import type { AnularFacturaDto } from './dto/anular-factura.dto';
import type { AplicacionSolicitadaDto } from '../recibos/dto/aplicacion-solicitada.dto';
import type { ListarNotasCreditoDto } from './dto/listar-notas-credito.dto';

/** One credit-side line `aplicarManual`/`aplicarFifo` produce, per concepto
 *  of the Factura they just settled — `cuenta: null` means the line's
 *  concepto has no `accountingReceivableAccount` configured, resolved to
 *  the coproperty's shared `cuentaCartera` only once `postearAsientoAplicacion`
 *  knows it (same "resolve the fallback account at the last possible
 *  moment" pattern `crear()`'s own `desglose` already uses).
 *  `tipoDocumento`/`numeroDocumento` are this application's own documento
 *  cruce — always the SPECIFIC Factura this line settled, never the note's
 *  own anchor (a deferred application can settle a completely different
 *  invoice). */
type DesgloseCarteraAplicacion = {
  cuenta: string | null;
  monto: number;
  tipoDocumento: 'FV';
  numeroDocumento: number;
};

/**
 * CANONICAL CONSTRUCTOR — pinned in Task 3, unchanged here. NO
 * `PeriodoService` argument: unlike `RecibosService`, `crear()` never checks
 * the accounting-period LOCK (`PeriodoService.exigirAbierto`) — only that
 * the caller-supplied `dto.fecha` falls in the CURRENT billing period, via
 * `lotes.obtenerUltimoConsolidado()` (already needed here for the
 * no-open-lote rule below), same as `RecibosService.crear()`'s own
 * `fechaRecibo` check.
 *
 * `lotes` was APPENDED for the "no Nota Crédito while a billing run is open"
 * rule — same reasoning as `RecibosService`'s own `lotes` argument.
 */
@Injectable()
export class NotasCreditoService {
  constructor(
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
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
  ) {}

  /** See `RecibosService.conAuxiliares`'s own docblock — identical shape.
   *  `documentoCruce` is the UNIFORM case (creation and its own reversal,
   *  which always reference the SAME anchor Factura) — `postearAsientoAplicacion`
   *  (deferred excess application, which can target a DIFFERENT document per
   *  línea) tags `tipoDocumento`/`numeroDocumento` per-línea instead, before
   *  calling this. */
  private async conAuxiliares(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    copropiedad: {
      defaultCostCentre: string | null;
      cashFlowCode: string | null;
    } | null,
    entries: ReturnType<typeof construirAsientoCruce>,
    documentoCruce?: { tipo: 'FV' | 'ND'; numero: number } | null,
  ): Promise<ReturnType<typeof construirAsientoCruce>> {
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
   * Creates a Nota Crédito and ALWAYS applies it immediately against its own
   * `facturaId` (design §5) — not optional, unlike Recibos: a Nota Crédito
   * has no meaning without its anchor invoice. Applies
   * `min(montoTotal, factura.outstandingBalance)`; any excess becomes
   * `unappliedAmount`, exactly like a Recibo's anticipo.
   */
  async crear(
    accountId: string,
    dto: CrearNotaCreditoDto,
  ): Promise<NotaCreditoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const facturaId = new Types.ObjectId(dto.facturaId);

    // The note's own date must fall in the same month/year as the last
    // consolidated billing run — same rule, same reasoning, same helper as
    // `RecibosService.crear()`'s identical check on `fechaRecibo`. A
    // coproperty that has never consolidated a lote has no "current period"
    // yet, so nothing to validate against.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la nota',
    );
    // A refusal costs no session — same placement as
    // RecibosService.crear()'s own periodo/lotes checks.
    await this.lotes.exigirSinLoteAbierto(coPropertyId.toString());

    return this.transaccion(async (session) => {
      const factura = await this.facturas
        .findOne({ _id: facturaId, coPropertyId })
        .session(session)
        .exec();
      if (!factura) {
        throw new NotFoundException(
          `No se encontró la factura ${dto.facturaId}`,
        );
      }
      // A voided invoice no longer represents active debt — crediting it
      // has no meaning (design §6).
      if (factura.status !== 'emitida') {
        throw new ConflictException(
          `La factura ${factura.fullNumber} está anulada y no admite una nota crédito`,
        );
      }

      const inmuebleId = new Types.ObjectId(dto.inmuebleId);
      if (!factura.inmuebleId.equals(inmuebleId)) {
        throw new ConflictException(
          `La factura ${factura.fullNumber} pertenece a otro inmueble ` +
            `(${factura.inmuebleId.toString()}) que el solicitado ` +
            `(${inmuebleId.toString()})`,
        );
      }

      // BadRequestException before ANY write — distribution shape is
      // checked against the anchor invoice's OWN lines, never the database.
      validarDistribucionNotaCredito(
        dto.distribucion.map((l) => ({
          conceptoId: l.conceptoId,
          monto: l.monto,
        })),
        dto.montoTotal,
        factura.lines,
      );

      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        dto.codigo,
        session,
      );

      const [creada] = await this.notasCredito.create(
        [
          {
            coPropertyId,
            inmuebleId,
            terceroId: factura.terceroId,
            facturaId,
            issueDate: new Date(dto.fecha),
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            reason: dto.motivo,
            totalAmount: dto.montoTotal,
            distribution: dto.distribucion.map((l) => ({
              conceptoId: new Types.ObjectId(l.conceptoId),
              amount: l.monto,
            })),
            // Frozen from here on — the document is immutable once issued.
            // `SaldoDocumentoOrigen` (seeded right below) is the live source
            // every application/reversal actually moves from now on.
            appliedAmount: 0,
            unappliedAmount: dto.montoTotal,
            notes: dto.observaciones ?? null,
            status: 'activo',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      await this.saldoDocumentoOrigen.create(
        [
          {
            coPropertyId,
            tipoDocumento: 'NC',
            documentoId: creada._id,
            montoOriginal: dto.montoTotal,
            saldoDisponible: dto.montoTotal,
          },
        ],
        { session },
      );

      // Always exactly one target: the anchor invoice itself — never a
      // manual/FIFO choice like Recibos' crear() (design §5). Read from
      // `SaldoTotalDocumento` — no longer a field on the (now immutable)
      // Factura itself, see that schema's own docblock.
      const saldoAncla = await this.saldoTotalDocumento
        .findOne({ documentoId: facturaId })
        .session(session)
        .exec();
      const montoAAplicar = Math.min(
        dto.montoTotal,
        saldoAncla?.saldoPendiente ?? 0,
      );
      // Whether this note's ENTIRE distribution lands against the anchor
      // invoice right now, with nothing left over to become anticipo — the
      // only case where excluding an `intereses` línea from the normal
      // CxC/Ingreso desglose below (see that comment) is provably still
      // balanced: `ajustarSaldosCarteraPorDistribucion` (called below)
      // returns `parte === linea.monto` for every line exactly when this is
      // true, so the débito and crédito sides drop the identical amount. A
      // PARTIAL application scales `partes` proportionally instead, which
      // would make an unscaled desgloseOrigen exclusion (below) disagree
      // with a scaled desglose exclusion and unbalance the entry — left as
      // existing behavior for that narrower case rather than risk that.
      const esAplicacionCompleta = montoAAplicar === dto.montoTotal;

      // The débito side of the creation entry, per concepto's own
      // `accountingIncomeAccount` (`ConceptoCobro.cuentaCreditoId`, frozen on
      // the anchor Factura's line) — the SAME account originally credited
      // when this concept was billed, so a credit note correctly reverses
      // THAT revenue instead of lumping every concept into one shared
      // "devoluciones" account (see `construirAsientoCruce`'s own
      // `desgloseOrigen` docblock). Built from `dto.distribucion` directly
      // (the user's FULL declared split, always summing to `dto.montoTotal`)
      // — never scaled to `montoAAplicar` below: even the portion that
      // becomes anticipo still reverses revenue for those same concepts, it
      // just hasn't been applied against a specific invoice balance yet.
      //
      // An `intereses` línea is the one exception: its ORIGINAL charge never
      // credited a real Ingreso account either — `construirMovimientos`
      // posts it through cuentasOrden instead (memo accounts) — so
      // reversing it through `accountingIncomeAccount` here would post a
      // real movement that was never really posted. `montoAplicadoMora`
      // below is what correctly reverses it, through cuentasOrden; skipped
      // only when `esAplicacionCompleta` (see that constant's own comment).
      const desgloseOrigen: DesgloseCarteraAplicacion[] = [];
      for (const linea of dto.distribucion) {
        const facturaLinea = factura.lines.find((l) =>
          l.conceptoId.equals(linea.conceptoId),
        );
        if (esAplicacionCompleta && facturaLinea?.conceptKind === 'intereses') {
          continue;
        }
        desgloseOrigen.push({
          cuenta: facturaLinea?.accountingIncomeAccount ?? null,
          monto: linea.monto,
          tipoDocumento: 'FV',
          numeroDocumento: factura.number,
        });
      }

      let totalAplicadoAhora = 0;
      // How much of THIS application landed on an `intereses` (mora) line —
      // the ONLY portion `cuentasOrden` may move (design §7 / see
      // `construirAsientoCruce`'s own note). Omitting it entirely, as this
      // call used to, defaults the builder to the note's FULL amount,
      // moving the memo pair even when the note never touched mora.
      let montoAplicadoMora = 0;
      const desglose: DesgloseCarteraAplicacion[] = [];
      if (montoAAplicar > 0) {
        // Needed now (unlike before per-concepto coding): each distribution
        // line's own accountingReceivableAccount comes off the anchor
        // Factura's own lines, matched by conceptoId.
        await decrementarSaldoFactura(
          this.facturas,
          this.saldoTotalDocumento,
          session,
          coPropertyId,
          facturaId,
          montoAAplicar,
        );
        // Distribution-based, NOT the proportional-by-invoice-line split
        // `ajustarSaldosCartera` uses — this application is against the
        // anchor invoice, whose concepto breakdown the user explicitly chose
        // via `dto.distribucion` (Task 11 / review Finding 3).
        const partes = await ajustarSaldosCarteraPorDistribucion(
          this.saldos,
          this.carteraPorDocumento,
          session,
          coPropertyId,
          inmuebleId,
          dto.distribucion.map((l) => ({
            conceptoId: new Types.ObjectId(l.conceptoId),
            monto: l.monto,
          })),
          montoAAplicar,
          -1,
          { tipoDocumento: 'FV', documentoId: facturaId },
        );
        const detalleConceptos = partes.map((parte) => {
          const linea = factura.lines.find((l) =>
            l.conceptoId.equals(parte.conceptoId),
          );
          return {
            conceptoId: parte.conceptoId,
            conceptName: linea?.conceptName ?? 'Concepto',
            monto: parte.parte,
          };
        });
        for (const parte of partes) {
          const linea = factura.lines.find((l) =>
            l.conceptoId.equals(parte.conceptoId),
          );
          const esIntereses = linea?.conceptKind === 'intereses';
          if (esIntereses) {
            montoAplicadoMora += parte.parte;
          }
          // Same exclusion, same guard, as desgloseOrigen above — an
          // intereses línea never credited a real CxC account either, only
          // cuentasOrden (via montoAplicadoMora).
          if (esIntereses && esAplicacionCompleta) continue;
          desglose.push({
            cuenta: linea?.accountingReceivableAccount ?? null,
            monto: parte.parte,
            tipoDocumento: 'FV',
            numeroDocumento: factura.number,
          });
        }
        await this.aplicaciones.create(
          [
            {
              coPropertyId,
              sourceType: 'NC',
              sourceId: creada._id,
              documentType: 'FV',
              documentId: facturaId,
              amountApplied: montoAAplicar,
              // Same "per-concepto breakdown, for printing" purpose as
              // `ejecutarAplicacionManual`'s identical field (cruce.util.ts)
              // — the ONLY point this split is ever reconstructable: `partes`
              // is computed once, here, from `dto.distribucion` scaled to
              // `montoAAplicar`, and never persisted anywhere else.
              detalleConceptos,
              status: 'activa',
              appliedAt: new Date(),
              sourceDate: fechaNotaCredito(creada),
              appliedBy: accountId,
            },
          ],
          { session },
        );
        await decrementarSaldoDocumentoOrigen(
          this.notasCredito,
          this.saldoDocumentoOrigen,
          session,
          coPropertyId,
          creada._id,
          montoAAplicar,
          'activo',
        );
        totalAplicadoAhora = montoAAplicar;
      }

      const notaActual = await this.notasCredito
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      await this.postearAsientoCreacion(
        session,
        coPropertyId,
        notaActual!,
        totalAplicadoAhora,
        dto.montoTotal - totalAplicadoAhora,
        desglose,
        desgloseOrigen,
        montoAplicadoMora,
        factura.number,
      );

      const final = await this.notasCredito
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaCredito(
        final!,
        totalAplicadoAhora,
        dto.montoTotal - totalAplicadoAhora,
      );
    });
  }

  /**
   * Voids a Factura by creating a full-amount Nota Crédito against it —
   * never a bare `status` flip. Delegates to `crear()` above for the actual
   * cartera adjustment and reversing accounting entry (same accounts that
   * entry originally moved, opposite direction — see `postearAsientoCreacion`'s
   * own docblock), so this method only adds the two things a plain creation
   * doesn't do on its own: refusing an invoice that already has ANY abono
   * (even one fully reverted since — the whole point of voiding is that the
   * invoice was never really settled), and stamping the Factura's own void
   * audit trail once that note exists.
   *
   * Lives here, not in `FacturasController`/`FacturasService`
   * (`FacturacionModule`), purely to avoid a circular require() graph:
   * `NotasCreditoModule` already imports `FacturacionModule` (for
   * `LotesFacturacionService`), and `RecibosModule` — which
   * `NotasCreditoModule` also imports — imports `FacturacionModule` too, so
   * `FacturacionModule` importing `NotasCreditoModule` back (even guarded by
   * `forwardRef`, which only defers NestJS's own provider resolution, not
   * the underlying `import` statement) crashes Node's module loader at boot
   * ("Cannot access 'FacturacionModule' before initialization" — confirmed
   * by trying it). Exposed via `AnularFacturaController`, registered in
   * `NotasCreditoModule`, routing `POST /facturas/:id/anular` despite living
   * in this module.
   */
  async anularFactura(
    id: string,
    dto: AnularFacturaDto,
    accountId: string,
  ): Promise<FacturaContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const facturaId = new Types.ObjectId(id);

    const factura = await this.facturas
      .findOne({ _id: facturaId, coPropertyId })
      .exec();
    if (!factura) {
      throw new NotFoundException(`No se encontró la factura ${id}`);
    }
    if (factura.status !== 'emitida') {
      throw new ConflictException(
        `La factura ${factura.fullNumber} ya está anulada`,
      );
    }

    const tieneAbonos = await this.aplicaciones
      .exists({ coPropertyId, documentType: 'FV', documentId: facturaId })
      .exec();
    if (tieneAbonos) {
      throw new ConflictException(
        `La factura ${factura.fullNumber} tiene abonos aplicados y no se puede anular`,
      );
    }

    // Mirrors the invoice's own lines into the credit note's distribution,
    // merged per concepto — a Factura can carry more than one line for the
    // same concepto (a recurrente charge plus a novedad override, say), but
    // `validarDistribucionNotaCredito` expects one cap per concepto.
    const montosPorConcepto = new Map<string, number>();
    for (const linea of factura.lines) {
      const key = linea.conceptoId.toString();
      montosPorConcepto.set(
        key,
        (montosPorConcepto.get(key) ?? 0) + linea.totalAmount,
      );
    }
    const distribucion = [...montosPorConcepto.entries()].map(
      ([conceptoId, monto]) => ({ conceptoId, monto }),
    );

    // `montoTotal: factura.total` against an untouched invoice (guarded
    // above) always fully applies, so nothing becomes anticipo.
    // `'anulacion_factura'` is DIAN's own code 2 ("Anulación de factura
    // electrónica") — the one creation-time motivo built for exactly this
    // case.
    const notaCredito = await this.crear(accountId, {
      codigo: dto.codigo,
      inmuebleId: factura.inmuebleId.toString(),
      facturaId: factura._id.toString(),
      fecha: dto.fecha,
      motivo: 'anulacion_factura',
      montoTotal: factura.total,
      distribucion,
      observaciones: `Anulación de la factura ${factura.fullNumber}: ${dto.detalle}`,
    });

    // The note above already zeroed the invoice's cartera and posted its
    // reversing entry. This is the other half `voidedByCreditNoteId`'s own
    // docblock anticipated: flip `status` so Consecutivos (which filters
    // strictly by status, never by live balance) stops counting this
    // invoice, and stamp the void's own audit trail — separate from the
    // note's own `reason`/`observaciones`, matching every other document
    // type's anulación fields.
    await this.facturas.updateOne(
      { _id: facturaId, coPropertyId },
      {
        $set: {
          status: 'anulada',
          voidedReason: dto.motivo,
          voidedDetail: dto.detalle,
          voidedAt: new Date(dto.fecha),
          voidedBy: accountId,
          voidedByCreditNoteId: new Types.ObjectId(notaCredito.id),
        },
      },
    );

    const facturaFinal = await this.facturas
      .findOne({ _id: facturaId, coPropertyId })
      .exec();
    return toFactura(facturaFinal!, 0, new Map());
  }

  /**
   * Applies an existing Nota Crédito's `unappliedAmount` against new
   * documents — the deferred-cruce case (design §5). Manual and FIFO share
   * the exact same private helpers below, so the two entry points never
   * drift apart — same structure as `RecibosService.aplicar()`. Posts via
   * `postearAsientoAplicacion`, never `postearAsientoCreacion` — the
   * `montoTotal` was already booked at creation time.
   */
  async aplicar(
    id: string,
    dto: AplicarNotaCreditoDto,
    accountId: string,
  ): Promise<ResultadoAplicacion> {
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

    return this.transaccion(async (session) => {
      const notaDoc = await this.notasCredito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!notaDoc) {
        throw new NotFoundException(`No se encontró la nota crédito ${id}`);
      }
      if (notaDoc.status !== 'activo') {
        throw new ConflictException(
          `La nota crédito ${notaDoc.fullNumber} está anulada y no admite nuevas aplicaciones`,
        );
      }
      // `unappliedAmount` is no longer a live field on the (now immutable)
      // NotaCredito — merged in fresh from `SaldoDocumentoOrigen`, same
      // pattern `decrementarSaldoFactura` uses for its own return value.
      const saldoOrigen = await this.saldoDocumentoOrigen
        .findOne({ documentoId: notaDoc._id })
        .session(session)
        .exec();
      const nota = Object.assign(notaDoc, {
        unappliedAmount: saldoOrigen?.saldoDisponible ?? 0,
      });

      if (dto.aplicaciones?.length) {
        const { creadas, desglose } = await this.aplicarManual(
          session,
          coPropertyId,
          nota,
          dto.aplicaciones,
          accountId,
        );
        const totalAplicado = creadas.reduce(
          (acc, a) => acc + a.amountApplied,
          0,
        );
        if (totalAplicado > 0) {
          await this.postearAsientoAplicacion(
            session,
            coPropertyId,
            nota,
            totalAplicado,
            desglose,
          );
        }
        const fechaNota = fechaNotaCredito(nota);
        return {
          aplicadas: creadas.map((a) =>
            toAplicacionCartera(a, null, fechaNota),
          ),
          montoSinAplicar: nota.unappliedAmount - totalAplicado,
          errores: [],
        };
      }

      const resultado = await this.aplicarFifo(
        session,
        coPropertyId,
        nota,
        nota.unappliedAmount,
        accountId,
      );
      const totalAplicado = resultado.aplicadas.reduce(
        (acc, a) => acc + a.amountApplied,
        0,
      );
      if (totalAplicado > 0) {
        await this.postearAsientoAplicacion(
          session,
          coPropertyId,
          nota,
          totalAplicado,
          resultado.desglose,
        );
      }
      const fechaNota = fechaNotaCredito(nota);
      return {
        aplicadas: resultado.aplicadas.map((a) =>
          toAplicacionCartera(a, null, fechaNota),
        ),
        montoSinAplicar: resultado.montoSinAplicar,
        errores: resultado.errores,
      };
    });
  }

  /** Mirrors `RecibosService.aplicarManual` exactly — `sourceType: 'NC'` in
   *  place of `'RC'`, `nota` in place of `recibo`. All-or-nothing: if the
   *  sum exceeds `nota.unappliedAmount`, or any line's cross-unit guard or
   *  `decrementarSaldoFactura` call throws, the whole transaction aborts. */
  private async aplicarManual(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaCreditoDocument,
    solicitadas: AplicacionSolicitadaDto[],
    accountId: string,
  ): Promise<{
    creadas: AplicacionCarteraDocument[];
    desglose: DesgloseCarteraAplicacion[];
  }> {
    const sumaSolicitada = solicitadas.reduce(
      (acc, a) => acc + a.montoAplicado,
      0,
    );
    if (sumaSolicitada > nota.unappliedAmount) {
      throw new ConflictException(
        `La suma solicitada (${sumaSolicitada}) supera el saldo sin aplicar ` +
          `de la nota crédito ${nota.fullNumber} (${nota.unappliedAmount})`,
      );
    }

    const creadas: AplicacionCarteraDocument[] = [];
    const desglose: DesgloseCarteraAplicacion[] = [];
    for (const solicitada of solicitadas) {
      const facturaId = new Types.ObjectId(solicitada.documentoId);
      const factura = await decrementarSaldoFactura(
        this.facturas,
        this.saldoTotalDocumento,
        session,
        coPropertyId,
        facturaId,
        solicitada.montoAplicado,
      );

      if (!factura.inmuebleId.equals(nota.inmuebleId)) {
        throw new ConflictException(
          `La factura ${facturaId.toString()} pertenece a otro inmueble ` +
            `(${factura.inmuebleId.toString()}) que la nota crédito ` +
            `${nota.fullNumber} (${nota.inmuebleId.toString()})`,
        );
      }

      const partes = await ajustarSaldosCartera(
        this.saldos,
        this.carteraPorDocumento,
        session,
        coPropertyId,
        factura,
        solicitada.montoAplicado,
        -1,
      );
      const detalleConceptos = partes.map((parte) => {
        const linea = factura.lines.find((l) =>
          l.conceptoId.equals(parte.conceptoId),
        );
        return {
          conceptoId: parte.conceptoId,
          conceptName: linea?.conceptName ?? 'Concepto',
          monto: parte.parte,
        };
      });
      // Documento cruce per línea: THIS factura, not the note's own anchor —
      // a deferred application can settle a completely different invoice.
      // Per-concepto accounts, same as `crear()`'s own `desglose`.
      for (const parte of partes) {
        const linea = factura.lines.find((l) =>
          l.conceptoId.equals(parte.conceptoId),
        );
        desglose.push({
          cuenta: linea?.accountingReceivableAccount ?? null,
          monto: parte.parte,
          tipoDocumento: 'FV',
          numeroDocumento: factura.number,
        });
      }

      const [creada] = await this.aplicaciones.create(
        [
          {
            coPropertyId,
            sourceType: 'NC',
            sourceId: nota._id,
            documentType: 'FV',
            documentId: facturaId,
            amountApplied: solicitada.montoAplicado,
            detalleConceptos,
            status: 'activa',
            appliedAt: new Date(),
            sourceDate: fechaNotaCredito(nota),
            appliedBy: accountId,
          },
        ],
        { session },
      );
      creadas.push(creada);
    }

    await decrementarSaldoDocumentoOrigen(
      this.notasCredito,
      this.saldoDocumentoOrigen,
      session,
      coPropertyId,
      nota._id,
      sumaSolicitada,
      'activo',
    );

    return { creadas, desglose };
  }

  /** Mirrors `RecibosService.aplicarFifo` exactly — `sourceType: 'NC'` in
   *  place of `'RC'`. Best-effort: stopping partway is the expected outcome,
   *  never a hard failure, except when a real bug (anything other than
   *  `AplicacionInvalidaError`) surfaces after a decrement already
   *  succeeded — that always aborts the whole transaction. */
  private async aplicarFifo(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaCreditoDocument,
    montoDisponible: number,
    accountId: string,
  ): Promise<{
    aplicadas: AplicacionCarteraDocument[];
    errores: ErrorAplicacion[];
    montoSinAplicar: number;
    desglose: DesgloseCarteraAplicacion[];
  }> {
    // Candidates bounded to this ONE inmueble (a small set) — fetched
    // first, THEN cross-referenced against `SaldoTotalDocumento` for which
    // still have a positive balance, since that's no longer a field this
    // query can filter on directly (see `SaldoTotalDocumento`'s docblock).
    const facturasDelInmueble = await this.facturas
      .find({ coPropertyId, inmuebleId: nota.inmuebleId, status: 'emitida' })
      .session(session)
      .exec();
    const idsDelInmueble = facturasDelInmueble.map((f) => f._id);
    const saldosTotales = idsDelInmueble.length
      ? await this.saldoTotalDocumento
          .find({
            documentoId: { $in: idsDelInmueble },
            saldoPendiente: { $gt: 0 },
          })
          .session(session)
          .exec()
      : [];
    const saldoPorDocumento = new Map(
      saldosTotales.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );
    const abiertas = facturasDelInmueble
      .filter((f) => saldoPorDocumento.has(f._id.toString()))
      .sort(
        (a, b) =>
          (a.dueDate ?? a.issueDate).getTime() -
          (b.dueDate ?? b.issueDate).getTime(),
      );

    const aplicadas: AplicacionCarteraDocument[] = [];
    const errores: ErrorAplicacion[] = [];
    const desglose: DesgloseCarteraAplicacion[] = [];
    let restante = montoDisponible;
    let totalAplicado = 0;

    for (const factura of abiertas) {
      if (restante <= 0) break;
      const monto = Math.min(
        restante,
        saldoPorDocumento.get(factura._id.toString())!,
      );

      try {
        const facturaActualizada = await decrementarSaldoFactura(
          this.facturas,
          this.saldoTotalDocumento,
          session,
          coPropertyId,
          factura._id,
          monto,
        );
        const partes = await ajustarSaldosCartera(
          this.saldos,
          this.carteraPorDocumento,
          session,
          coPropertyId,
          facturaActualizada,
          monto,
          -1,
        );
        const detalleConceptos = partes.map((parte) => {
          const linea = facturaActualizada.lines.find((l) =>
            l.conceptoId.equals(parte.conceptoId),
          );
          return {
            conceptoId: parte.conceptoId,
            conceptName: linea?.conceptName ?? 'Concepto',
            monto: parte.parte,
          };
        });
        // Documento cruce per línea — same reasoning as `aplicarManual`'s
        // own identical block.
        for (const parte of partes) {
          const linea = facturaActualizada.lines.find((l) =>
            l.conceptoId.equals(parte.conceptoId),
          );
          desglose.push({
            cuenta: linea?.accountingReceivableAccount ?? null,
            monto: parte.parte,
            tipoDocumento: 'FV',
            numeroDocumento: facturaActualizada.number,
          });
        }

        const [creada] = await this.aplicaciones.create(
          [
            {
              coPropertyId,
              sourceType: 'NC',
              sourceId: nota._id,
              documentType: 'FV',
              documentId: factura._id,
              amountApplied: monto,
              detalleConceptos,
              status: 'activa',
              appliedAt: new Date(),
              sourceDate: fechaNotaCredito(nota),
              appliedBy: accountId,
            },
          ],
          { session },
        );

        aplicadas.push(creada);
        restante -= monto;
        totalAplicado += monto;
      } catch (err) {
        if (!(err instanceof AplicacionInvalidaError)) {
          throw err;
        }
        errores.push({
          documentoId: factura._id.toString(),
          mensaje: err.message,
        });
      }
    }

    if (totalAplicado > 0) {
      await decrementarSaldoDocumentoOrigen(
        this.notasCredito,
        this.saldoDocumentoOrigen,
        session,
        coPropertyId,
        nota._id,
        totalAplicado,
        'activo',
      );
    }

    return { aplicadas, errores, montoSinAplicar: restante, desglose };
  }

  /**
   * Voids a Nota Crédito, cascading unconditionally: every `activa`
   * `AplicacionCartera` it made (`sourceType: 'NC'`) is reversed, its
   * `Factura`'s `outstandingBalance` is restored — even one already voided
   * through another path, harmless bookkeeping, never "reopens" that
   * document — and ONE consolidated reversing journal entry is always
   * posted, using the Nota Crédito's OWN cached totals. Mirrors
   * `RecibosService.anular()` exactly.
   */
  async anular(
    id: string,
    dto: AnularNotaCreditoDto,
    accountId: string,
  ): Promise<NotaCreditoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // The reversing asiento is dated by the user, never by the server clock
    // — same rule as creation, same reasoning: the accountant controls
    // every document date in the ledger, this system never assumes "today".
    // A refusal costs no session — same placement as `crear()`'s own check.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la anulación',
    );

    return this.transaccion(async (session) => {
      const notaDoc = await this.notasCredito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!notaDoc) {
        throw new NotFoundException(`No se encontró la nota crédito ${id}`);
      }
      if (notaDoc.status === 'anulado') {
        throw new ConflictException(
          `La nota crédito ${notaDoc.fullNumber} ya está anulada`,
        );
      }
      // `appliedAmount`/`unappliedAmount` are no longer live fields on the
      // (now immutable) NotaCredito — merged in fresh from
      // `SaldoDocumentoOrigen` so the reversing entry below (which reads the
      // note's OWN cached totals) sees the REAL current split.
      const saldoOrigenPrevio = await this.saldoDocumentoOrigen
        .findOne({ documentoId: notaDoc._id })
        .session(session)
        .exec();
      const nota = Object.assign(notaDoc, {
        unappliedAmount: saldoOrigenPrevio?.saldoDisponible ?? 0,
        appliedAmount:
          (saldoOrigenPrevio?.montoOriginal ?? 0) -
          (saldoOrigenPrevio?.saldoDisponible ?? 0),
      });

      const aplicacionesActivas = await this.aplicaciones
        .find({
          coPropertyId,
          sourceType: 'NC',
          sourceId: nota._id,
          status: 'activa',
        })
        .session(session)
        .exec();

      // Mora-specific slice of everything being reversed here, accumulated
      // across every aplicación (there can be more than one anchor + later
      // `aplicar()` calls against other invoices) — the ONLY portion
      // `cuentasOrden` may move on the way back too (mirrors `crear()`'s own
      // `montoAplicadoMora`, see `construirContraAsientoCruce`'s note).
      let montoAplicadoMoraTotal = 0;
      for (const aplicacion of aplicacionesActivas) {
        const facturaDoc = await this.facturas
          .findOne({ _id: aplicacion.documentId, coPropertyId })
          .session(session)
          .exec();

        if (facturaDoc) {
          const saldoRestaurado = await restaurarSaldoTotalDocumento(
            this.saldoTotalDocumento,
            session,
            facturaDoc._id,
            aplicacion.amountApplied,
          );
          const factura = Object.assign(facturaDoc, {
            outstandingBalance: saldoRestaurado?.saldoPendiente ?? 0,
          });
          // `detalleConceptos` is empty on an application predating that
          // field (schema's own note) — contributes nothing to
          // `montoAplicadoMoraTotal`, same "no known split" fallback the
          // frontend already uses for those.
          for (const detalle of aplicacion.detalleConceptos ?? []) {
            const linea = factura.lines.find((l) =>
              l.conceptoId.equals(detalle.conceptoId),
            );
            if (linea?.conceptKind === 'intereses') {
              montoAplicadoMoraTotal += detalle.monto;
            }
          }
          // The ANCHOR application — the one `crear()` made against
          // `nota.facturaId` using distribution math — must be reversed with
          // the SAME distribution math, or `SaldoCartera` drifts permanently
          // on every void (Task 11 / review Finding 3). Every OTHER
          // application (made later via `aplicar()` against a different
          // invoice) was created with the proportional split and must keep
          // being reversed that way, unchanged.
          //
          // INVARIANT this branch relies on: at most one ACTIVE application
          // can ever target `nota.facturaId`. Holds today because
          // `decrementarSaldoFactura`'s $expr guard refuses a second
          // application once the anchor invoice's outstandingBalance hits 0
          // (which is exactly when `crear()` stops applying against it) — so
          // no code path in this module can create a second anchor-targeting
          // row. If a future feature (e.g. a recargo) re-inflates a
          // Factura's outstandingBalance after it reaches 0, re-check this
          // invariant before trusting it again.
          if (aplicacion.documentId.equals(nota.facturaId)) {
            await ajustarSaldosCarteraPorDistribucion(
              this.saldos,
              this.carteraPorDocumento,
              session,
              coPropertyId,
              nota.inmuebleId,
              nota.distribution.map((l) => ({
                conceptoId: l.conceptoId,
                monto: l.amount,
              })),
              aplicacion.amountApplied,
              1,
              { tipoDocumento: 'FV', documentoId: aplicacion.documentId },
            );
          } else {
            await ajustarSaldosCartera(
              this.saldos,
              this.carteraPorDocumento,
              session,
              coPropertyId,
              factura,
              aplicacion.amountApplied,
              1,
            );
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

      const copropiedad = await this.copropiedades
        .findById(coPropertyId)
        .session(session)
        .exec();
      const cuentaCartera =
        copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaAnticipos =
        copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaDevoluciones =
        copropiedad?.creditNotesAccount ?? CUENTA_SIN_ASIGNAR;
      // Restores the SAME per-concepto income accounts `postearAsientoCreacion`
      // actually debited — read fresh rather than reused from the loop above,
      // since the anchor Factura is only touched there when an ACTIVE
      // application against it exists (never true when its outstandingBalance
      // was already 0 at creation), while this débito reversal always covers
      // the note's FULL `totalAmount`/`distribution`, applied or not.
      const facturaAncla = await this.facturas
        .findOne({ _id: nota.facturaId, coPropertyId })
        .session(session)
        .exec();
      const desgloseOrigen = nota.distribution.map((linea) => {
        const lineaFactura = facturaAncla?.lines.find((l) =>
          l.conceptoId.equals(linea.conceptoId),
        );
        return {
          account: lineaFactura?.accountingIncomeAccount ?? cuentaDevoluciones,
          monto: linea.amount,
        };
      });
      let entries = construirContraAsientoCruce(
        cuentaDevoluciones,
        cuentaCartera,
        cuentaAnticipos,
        nota.appliedAmount,
        nota.unappliedAmount,
        nota.totalAmount,
        'NC',
        cuentasOrdenDe(copropiedad),
        undefined,
        montoAplicadoMoraTotal,
        undefined,
        desgloseOrigen,
      );
      entries = await this.conAuxiliares(
        session,
        coPropertyId,
        nota.inmuebleId,
        copropiedad,
        entries,
        facturaAncla ? { tipo: 'FV', numero: facturaAncla.number } : null,
      );
      await this.asientos.create(
        [
          {
            coPropertyId,
            loteId: null,
            facturaId: null,
            reciboId: null,
            notaCreditoId: nota._id,
            // The date the user declared for THIS anulación (validated
            // above, before the transaction opened) — never `new Date()`.
            // `voidedAt` below stays the real audit instant on purpose (see
            // its own field comment): this is the business date, that is
            // the "when it was actually recorded" trail — never the same
            // field, never conflated.
            date: new Date(dto.fecha),
            entries,
          },
        ],
        { session },
      );

      // Once voided, a Nota Crédito offers no anticipo and shows no applied
      // amount — same deliberate zeroing choice as RecibosService.anular().
      await this.notasCredito
        .findOneAndUpdate(
          { _id: id, coPropertyId },
          {
            $set: {
              status: 'anulado',
              voidedReason: dto.motivo,
              voidedDetail: dto.detalle,
              voidedAt: new Date(),
              voidedBy: accountId,
              appliedAmount: 0,
              unappliedAmount: 0,
            },
          },
          { session },
        )
        .exec();
      // The REAL live balance — `SaldoDocumentoOrigen` — goes to zero too,
      // same "no anticipo, no applied amount" outcome as the `$set` above.
      await this.saldoDocumentoOrigen
        .updateOne(
          { documentoId: id },
          { $set: { saldoDisponible: 0 } },
          { session },
        )
        .exec();

      const final = await this.notasCredito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toNotaCredito(final!, 0, 0);
    });
  }

  /**
   * Lean listing (design §5, `GET /notas-credito`) — always scoped to the
   * active copropiedad, honoring `ListarNotasCreditoDto`'s filters
   * (`inmuebleId`, `estado`, date range on `issueDate`). Uses `toNotaCredito`,
   * never `toNotaCreditoDetalle` — no per-row `AplicacionCartera` lookup
   * here, unlike `findOne` below. Mirrors `RecibosService.findAll`.
   */
  async findAll(
    query: ListarNotasCreditoDto,
  ): Promise<Paginado<NotaCreditoContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;
    if (query.conAnticipoDisponible) {
      // No longer a field on NotaCredito itself — resolve candidate ids from
      // `SaldoDocumentoOrigen` first, same pattern `RecibosService.findAll`
      // already uses.
      const conSaldo = await this.saldoDocumentoOrigen
        .find({
          coPropertyId,
          tipoDocumento: 'NC',
          saldoDisponible: { $gt: 0 },
        })
        .exec();
      filtro._id = { $in: conSaldo.map((s) => s.documentoId) };
    }
    if (query.desde || query.hasta) {
      const rango = {
        ...(query.desde ? { $gte: new Date(query.desde) } : {}),
        ...(query.hasta ? { $lte: new Date(query.hasta) } : {}),
      };
      // A note carries a real `issueDate` from this feature onward; one
      // created before it existed has `issueDate: null` and must fall back
      // to `createdAt` — same fallback `fechaNotaCredito` applies when
      // reading a single document, expressed as a query since Mongo can't
      // run that function per-row.
      filtro.$or = [
        { issueDate: rango },
        { issueDate: null, createdAt: rango },
      ];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.notasCredito
        .find(filtro)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.notasCredito.countDocuments(filtro).exec(),
    ]);

    const ids = documentos.map((d) => d._id);
    const saldos = ids.length
      ? await this.saldoDocumentoOrigen
          .find({ documentoId: { $in: ids } })
          .exec()
      : [];
    const saldoPorDocumento = new Map(
      saldos.map((s) => [
        s.documentoId.toString(),
        { montoOriginal: s.montoOriginal, saldoDisponible: s.saldoDisponible },
      ]),
    );

    return {
      items: documentos.map((doc) => {
        const saldo = saldoPorDocumento.get(doc._id.toString());
        const montoSinAplicar = saldo?.saldoDisponible ?? 0;
        const montoAplicado = saldo
          ? saldo.montoOriginal - saldo.saldoDisponible
          : 0;
        return toNotaCredito(doc, montoAplicado, montoSinAplicar);
      }),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Full detail (design §5, `GET /notas-credito/:id`) — includes the
   * `aplicaciones` array via a separate query against `AplicacionCartera`,
   * assembled through `toNotaCreditoDetalle`. Mirrors `RecibosService.findOne`.
   */
  async findOne(id: string): Promise<NotaCreditoDetalle> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasCredito
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota crédito ${id}`);
    }
    const saldoOrigen = await this.saldoDocumentoOrigen
      .findOne({ documentoId: nota._id })
      .exec();
    const montoSinAplicar = saldoOrigen?.saldoDisponible ?? 0;
    const montoAplicado = saldoOrigen
      ? saldoOrigen.montoOriginal - saldoOrigen.saldoDisponible
      : 0;
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, sourceType: 'NC', sourceId: nota._id })
      .sort({ appliedAt: 1 })
      .exec();

    // Batch-resolve every Factura's own printed number ("FV-1") this note
    // needs for display: its own anchor (`nota.facturaId`, always — a
    // deferred application may have never touched it, e.g. its
    // outstandingBalance was already 0 at creation) plus every distinct
    // Factura an `aplicacion` actually targeted (never necessarily the
    // anchor — see `toNotaCreditoDetalle`'s own docblock). Same reasoning as
    // `RecibosService.findOne`'s identical `numerosPorDocumento`.
    const facturaIdsPorClave = new Map<string, Types.ObjectId>(
      [nota.facturaId, ...aplicaciones.map((a) => a.documentId)].map((id) => [
        id.toString(),
        id,
      ]),
    );
    const facturasDoc = await this.facturas
      .find({ coPropertyId, _id: { $in: [...facturaIdsPorClave.values()] } })
      .exec();
    const numerosPorDocumento = new Map(
      facturasDoc.map((f) => [f._id.toString(), f.fullNumber]),
    );

    return toNotaCreditoDetalle(
      nota,
      montoAplicado,
      montoSinAplicar,
      aplicaciones,
      numerosPorDocumento,
    );
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation.
   */
  async findOneRaw(id: string): Promise<NotaCreditoDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasCredito
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota crédito ${id}`);
    }
    return nota;
  }

  /** Posts a LATER application's journal entry: debit `cuentaAnticipos`,
   *  credit `cuentaCartera` (per concepto/documento, via `desglose` — see
   *  `construirMovimientosAplicacionAnticipo`), both for `montoAplicado` —
   *  never touches `cuentaDevoluciones` again (the correction was already
   *  booked at creation time). Only called when `montoAplicado > 0`. */
  private async postearAsientoAplicacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaCreditoDocument,
    montoAplicado: number,
    desglose: DesgloseCarteraAplicacion[],
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
      'NC',
      desgloseCartera,
    );
    // Per-línea documento cruce is already set on `entries` above (from
    // `desgloseCartera`) — `conAuxiliares` never overwrites it (see its own
    // `?? contexto.documentoCruce` check), it only fills tercero/centroCosto/
    // flujoCaja here.
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
          notaCreditoId: nota._id,
          date: new Date(),
          entries,
        },
      ],
      { session },
    );
  }

  /**
   * Posts the CREATION-time journal entry: debit `cuentaDevoluciones` for
   * the full `montoTotal`, credit cartera for whatever applied against the
   * anchor invoice in this call (per concepto, via `desgloseCartera` — see
   * `construirAsientoCruce`), credit `cuentaAnticipos` for whatever remains
   * unapplied (design §7). Shares `construirAsientoCruce` with Recibos —
   * only `origen: 'NC'` differs.
   *
   * `montoAplicadoMora` is the mora-specific slice of `montoAplicado` (the
   * ONLY portion `cuentasOrden` may move — same rule Recibos' own
   * `montoAplicadoMora` enforces) — never omitted, or `construirAsientoCruce`
   * defaults to moving the memo pair for the note's WHOLE amount, even one
   * that never touched an `intereses` concept.
   */
  private async postearAsientoCreacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaCreditoDocument,
    montoAplicado: number,
    montoSinAplicar: number,
    desglose: DesgloseCarteraAplicacion[],
    desgloseOrigen: DesgloseCarteraAplicacion[],
    montoAplicadoMora: number,
    numeroFacturaAncla: number,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaDevoluciones =
      copropiedad?.creditNotesAccount ?? CUENTA_SIN_ASIGNAR;
    const desgloseCartera = desglose.map((d) => ({
      account: d.cuenta ?? cuentaCartera,
      monto: d.monto,
      tipoDocumento: d.tipoDocumento,
      numeroDocumento: d.numeroDocumento,
    }));
    // Per-concepto income accounts for the débito side — see
    // `construirAsientoCruce`'s own `desgloseOrigen` docblock. Falls back to
    // `cuentaDevoluciones` (never a bare `null` account) for a concept with
    // no `accountingIncomeAccount` configured, same fallback role
    // `cuentaCartera` plays for `desgloseCartera` above.
    const desgloseOrigenCuentas = desgloseOrigen.map((d) => ({
      account: d.cuenta ?? cuentaDevoluciones,
      monto: d.monto,
      tipoDocumento: d.tipoDocumento,
      numeroDocumento: d.numeroDocumento,
    }));
    let entries = construirAsientoCruce(
      cuentaDevoluciones,
      cuentaCartera,
      cuentaAnticipos,
      montoAplicado,
      montoSinAplicar,
      'NC',
      cuentasOrdenDe(copropiedad),
      desgloseCartera,
      montoAplicadoMora,
      undefined,
      desgloseOrigenCuentas,
    );
    entries = await this.conAuxiliares(
      session,
      coPropertyId,
      nota.inmuebleId,
      copropiedad,
      entries,
      { tipo: 'FV', numero: numeroFacturaAncla },
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: null,
          notaCreditoId: nota._id,
          // The note's OWN declared date, never `new Date()` — same
          // reasoning as `postearAsientoRecibo`'s `recibo.receivedDate`.
          // `aplicar()`/`anular()` stay dated `new Date()` (the real cruce
          // instant, no caller-supplied date to prefer) — this is creation,
          // which does have one. Getting this wrong is exactly why a
          // backdated Nota Crédito could silently vanish from Consulta de
          // Movimientos when queried by its own declared period.
          date: fechaNotaCredito(nota),
          entries,
        },
      ],
      { session },
    );
  }
}
