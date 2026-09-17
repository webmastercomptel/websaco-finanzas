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
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
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
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  actualizarRemanentesLinea,
  ajustarSaldosCarteraPorDistribucion,
  decrementarSaldoDocumentoOrigen,
  ejecutarAplicacionFifo,
  ejecutarAplicacionManual,
  remanentesPorLinea,
  restaurarSaldoTotalDocumento,
  type DesgloseCarteraAplicacion,
  type ResumenAplicacion,
} from './cruce.util';
import {
  construirAsientoCruce,
  construirContraAsientoCruce,
  cuentasOrdenDe,
  enriquecerMovimientosConAuxiliares,
  CUENTA_SIN_ASIGNAR,
  type MarcasCuentaContable,
} from '../facturacion/asiento.builder';
import { toRecibo, toReciboDetalle } from './recibos.mapper';
import { construirDatosImpresionRecibo } from './recibo-pdf-datos.util';
import type {
  Recibo as ReciboContract,
  ErrorAplicacion,
  Paginado,
  ReciboDetalle,
} from '../../contracts';
import type { CrearReciboDto } from './dto/crear-recibo.dto';
import type { AplicacionSolicitadaDto } from './dto/aplicacion-solicitada.dto';
import type { AnularReciboDto } from './dto/anular-recibo.dto';
import type { ListarRecibosDto } from './dto/listar-recibos.dto';

/**
 * Redacts "Cancela facturas 6, 173, 340 y genera anticipo" / "Abona a
 * factura 341" from the applications a `crear()` call actually made — the
 * single source of truth for both Automática (FIFO, decided entirely
 * server-side) and Manual (the client already composes an equivalent
 * preview from its own selections, but the server-computed text still wins
 * whenever the caller left `observaciones` blank, so both paths render
 * identically). Mirrors `recibo-nuevo.tsx`'s `observacionesSugeridas`
 * formatting exactly: bare document numbers (never the prefixed
 * `fullNumber`), comma-only joins (no "y" before the last one — that "y" is
 * reserved for chaining "genera anticipo"), grouped Cancela-antes-que-Abona,
 * Facturas-antes-que-Notas-Débito.
 */
const redactarObservaciones = (
  resumen: ResumenAplicacion[],
  generaAnticipo: boolean,
): string => {
  const facturasCanceladas = resumen
    .filter((r) => r.tipo === 'FV' && r.completa)
    .map((r) => r.numero);
  const facturasAbonadas = resumen
    .filter((r) => r.tipo === 'FV' && !r.completa)
    .map((r) => r.numero);
  const notasCanceladas = resumen
    .filter((r) => r.tipo === 'ND' && r.completa)
    .map((r) => r.numero);
  const notasAbonadas = resumen
    .filter((r) => r.tipo === 'ND' && !r.completa)
    .map((r) => r.numero);

  const clausula = (
    verbo: string,
    etiquetaSingular: string,
    etiquetaPlural: string,
    numeros: number[],
  ): string | null =>
    numeros.length === 0
      ? null
      : `${verbo} ${numeros.length === 1 ? etiquetaSingular : etiquetaPlural} ${numeros.join(', ')}`;

  const partes = [
    clausula('Cancela', 'factura', 'facturas', facturasCanceladas),
    clausula('Abona a', 'factura', 'facturas', facturasAbonadas),
    clausula('Cancela', 'nota débito', 'notas débito', notasCanceladas),
    clausula('Abona a', 'nota débito', 'notas débito', notasAbonadas),
  ].filter((p): p is string => p !== null);

  if (partes.length === 0) {
    return generaAnticipo ? 'Genera anticipo' : '';
  }
  return partes.join('. ') + (generaAnticipo ? ' y genera anticipo' : '');
};

/**
 * CANONICAL CONSTRUCTOR — pinned while the ten tasks of this plan were being
 * built, so no task could reorder it out from under another (same discipline
 * `LotesFacturacionService` documents on its own constructor). `asientos` and
 * `copropiedades` are used on EVERY `crear()` call, unconditionally — not
 * only when `aplicaciones`/`aplicacionAutomatica` is present — because the
 * full `receivedAmount` must always be booked (debited to
 * `destinationAccount`) the moment a Recibo is created, whether or not any of
 * it has been applied yet (design decision, Task 2); `numeracion` and
 * `connection` are what make RC numbering and every balance write live inside
 * one Mongo transaction (design §6).
 *
 * `periodo` was APPENDED as a tenth argument after the plan closed: `crear()`
 * must honor the accounting-period lock like every other dated document does
 * (see `PeriodoService.exigirAbierto`'s own docblock, and
 * `LotesFacturacionService.consolidar()`). It is last precisely so the nine
 * positions above kept their meaning.
 *
 * `notasDebito` was APPENDED as an eleventh argument when Notas Débito
 * shipped: `aplicarManual`/`aplicarFifo` must be able to decrement a Nota
 * Débito's own `outstandingBalance` (via `decrementarSaldoNotaDebito`),
 * since `AplicacionCartera.documentType` admits `'ND'` as a target and a
 * Recibo can pay one exactly like it pays a Factura (Notas Débito design
 * §5/§6). Same append-only discipline as `periodo` — last, so every
 * position above keeps its meaning.
 *
 * `lotes` was APPENDED as a twelfth argument for the "no Recibo while a
 * billing run is open" rule: `crear()` calls
 * `lotes.exigirSinLoteAbierto()` before the transaction opens, same
 * placement as `periodo.exigirAbierto` — a refusal costs no session.
 *
 * `saldoDocumentoOrigen` was APPENDED for the same reason `saldoTotalDocumento`
 * was: `Recibo.appliedAmount`/`unappliedAmount` are no longer live fields on
 * the (now immutable) document — `SaldoDocumentoOrigen` is where
 * `decrementarSaldoDocumentoOrigen`/`restaurarSaldoDocumentoOrigen` now read
 * and write that balance (see that schema's own docblock).
 *
 * `terceros` and `presentacionDocumento` were APPENDED, trailing and
 * optional (same reasoning as `cuentasContables`/`inmuebles` right above),
 * when `crear()` took over freezing this Recibo's own `documentDefinition`
 * into the shared `presentacion_documento` table — see
 * `congelarPresentacionRecibo`. `terceros` is needed only for that step
 * (`construirDatosImpresionRecibo`'s own `modelos.terceros`); every existing
 * positional test keeps compiling with both left `undefined`, in which case
 * `congelarPresentacionRecibo` simply no-ops.
 */
@Injectable()
export class RecibosService {
  private readonly logger = new Logger(RecibosService.name);

  constructor(
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
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
    private readonly periodo: PeriodoService,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
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

  /**
   * Runs `fn` inside one Mongo transaction. Every mutating method on this
   * service (`crear`, `aplicar` — Task 8, `anular` — Task 9) is exactly one
   * call to this (design §6: "every mutating operation is one Mongo
   * transaction").
   */
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
   * Creates a Recibo. With `aplicaciones` present, applies them manually in
   * the same transaction (all-or-nothing, design §6); with
   * `aplicacionAutomatica`, Task 7 wires FIFO in here instead. Neither
   * present: the whole `montoRecibido` becomes anticipo.
   */
  async crear(accountId: string, dto: CrearReciboDto): Promise<ReciboContract> {
    if (dto.aplicaciones?.length && dto.aplicacionAutomatica) {
      throw new BadRequestException(
        'No se puede pedir aplicación manual y automática a la vez',
      );
    }
    // Same guard `aplicar()` already had — the user must explicitly choose
    // automática or manual, never leave both empty. A receipt with truly
    // nothing to apply against still satisfies this by choosing automática
    // (FIFO finds no open cartera and the whole amount becomes anticipo).
    if (!dto.aplicaciones?.length && !dto.aplicacionAutomatica) {
      throw new BadRequestException(
        'Debe indicar aplicaciones manuales o aplicación automática',
      );
    }
    const sumaSolicitada = (dto.aplicaciones ?? []).reduce(
      (acc, a) => acc + a.montoAplicado,
      0,
    );
    // A shortfall (paying $848.000 against $849.000 of aplicaciones, say)
    // is rejected UNLESS the caller explicitly confirmed sending the
    // difference to the coproperty's own cuenta de Descuentos — never
    // inferred, since it could just as easily be a digitación error. Manual
    // mode only: `aplicacionAutomatica`'s own FIFO walk never over-applies
    // beyond `montoRecibido` in the first place, so this never fires there.
    const diferenciaSolicitada = sumaSolicitada - dto.montoRecibido;
    if (diferenciaSolicitada > 0 && !dto.confirmarDescuentoFaltante) {
      throw new BadRequestException(
        `La suma de las aplicaciones (${sumaSolicitada}) supera el monto recibido ` +
          `(${dto.montoRecibido}) por ${diferenciaSolicitada}. Confirme el envío de ` +
          `la diferencia a la cuenta de Descuentos para continuar.`,
      );
    }
    const diferenciaConfirmada =
      diferenciaSolicitada > 0 ? diferenciaSolicitada : 0;

    // Mirror check for the OTHER sign: a manual submission that leaves cash
    // over must say where it goes — Anticipos (today's only, silent
    // behavior) or Otros Ingresos. A naive pre-transaction estimate, same
    // caveat as `diferenciaSolicitada` above (an early-payment discount
    // elsewhere in this same recibo could shift the real figure slightly;
    // harmless either way, since the fallback stays Anticipos). Automática
    // never asks — FIFO leaving cash unapplied is routine, not a decision.
    const sobranteSolicitado = -diferenciaSolicitada;
    if (
      dto.aplicaciones?.length &&
      sobranteSolicitado > 0 &&
      !dto.destinoSobrante
    ) {
      throw new BadRequestException(
        `Sobran ${sobranteSolicitado} de lo recibido (${dto.montoRecibido}) ` +
          `frente a lo aplicado (${sumaSolicitada}). Indique si van a Anticipos ` +
          `o a Otros Ingresos.`,
      );
    }

    const coPropertyId = this.tenant.resolveCoPropertyId();

    // Every document that carries a date passes through here before being
    // saved (see `PeriodoService.exigirAbierto`'s docblock) — otherwise a
    // backdated Recibo lands in a month the council already closed and
    // reported on, and its asiento moves the opening balance of every month
    // after it. Checked against `fechaRecibo`, the date the DOCUMENT claims,
    // never `new Date()`: backdating is exactly what this guards.
    //
    // Placed before `transaccion()` opens, mirroring
    // `LotesFacturacionService.consolidar()` — a refusal costs no session.
    // `aplicar()` and `anular()` need no equivalent: their asientos are dated
    // `new Date()`, the instant the operation actually happened, never a
    // caller-supplied date.
    await this.periodo.exigirAbierto(
      coPropertyId.toString(),
      new Date(dto.fechaRecibo),
    );
    // The payment date must fall in the same month/year as the last
    // consolidated billing run — a Recibo dated outside the current
    // billing period reads as paying a period that hasn't been (or is no
    // longer being) billed. A coproperty that has never consolidated a
    // lote has no "current period" yet, so nothing to validate against.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fechaRecibo),
      ultimoLote,
      'La fecha de pago',
    );
    // Same "a refusal costs no session" placement: SaldoCartera and every
    // FacturaPreliminar total can still move while a billing run is open, so
    // a Recibo applied against them mid-run would settle against numbers
    // about to change.
    await this.lotes.exigirSinLoteAbierto(coPropertyId.toString());

    const destinationAccount =
      dto.cuentaDestino ??
      (await this.copropiedades.findById(coPropertyId).exec())
        ?.defaultBankAccountCode;
    if (!destinationAccount) {
      throw new BadRequestException(
        'La cuenta destino es requerida cuando no hay cuenta predeterminada en la copropiedad.',
      );
    }

    const resultado = await this.transaccion(async (session) => {
      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        dto.codigo,
        session,
      );

      const [creado] = await this.recibos.create(
        [
          {
            coPropertyId,
            inmuebleId: new Types.ObjectId(dto.inmuebleId),
            terceroId: new Types.ObjectId(dto.terceroId),
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            receivedAmount: dto.montoRecibido,
            receivedDate: new Date(dto.fechaRecibo),
            paymentMethod: dto.medioPago,
            destinationAccount,
            reference: dto.referencia ?? null,
            notes: dto.observaciones ?? null,
            // Frozen from here on — the document is immutable once issued.
            // `SaldoDocumentoOrigen` (seeded right below) is the live source
            // every application/reversal actually moves from now on.
            appliedAmount: 0,
            unappliedAmount: dto.montoRecibido,
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
            tipoDocumento: 'RC',
            documentoId: creado._id,
            montoOriginal: dto.montoRecibido,
            saldoDisponible: dto.montoRecibido,
          },
        ],
        { session },
      );

      let totalAplicadoAhora = 0;
      let desglose: DesgloseCarteraAplicacion[] = [];
      let montoAplicadoMora = 0;
      let montoDescuentoAhora = 0;
      let resumenAplicaciones: ResumenAplicacion[] = [];
      if (dto.aplicaciones?.length) {
        const resultado = await this.aplicarManual(
          session,
          coPropertyId,
          creado,
          dto.aplicaciones,
          accountId,
          diferenciaConfirmada,
        );
        totalAplicadoAhora = resultado.creadas.reduce(
          (acc, a) => acc + a.amountApplied,
          0,
        );
        desglose = resultado.desglose;
        montoAplicadoMora = resultado.montoAplicadoMora;
        resumenAplicaciones = resultado.resumen;
        // Already includes `diferenciaConfirmada` — `ejecutarAplicacionManual`
        // folds it in (see that function's own `descuentoConfirmadoExtra`).
        montoDescuentoAhora = resultado.montoDescuentoTotal;
      } else if (dto.aplicacionAutomatica) {
        const resultado = await this.aplicarFifo(
          session,
          coPropertyId,
          creado,
          dto.montoRecibido,
          accountId,
        );
        totalAplicadoAhora = resultado.aplicadas.reduce(
          (acc, a) => acc + a.amountApplied,
          0,
        );
        desglose = resultado.desglose;
        montoAplicadoMora = resultado.montoAplicadoMora;
        resumenAplicaciones = resultado.resumen;
        montoDescuentoAhora = resultado.montoDescuentoTotal;
      }
      // Don't claim "pronto pago" when (part of) the discount is really a
      // manually confirmed shortfall — see `postearAsientoRecibo`'s own
      // note on `descripcionDescuento`.
      const descripcionDescuento =
        diferenciaConfirmada > 0 ? 'Descuento — recibo de caja' : undefined;

      // `totalAplicadoAhora` already includes any early-payment discount
      // summed in (see `evaluarAplicacionConDescuento`, cruce.util.ts) — the
      // real cash this call drew from `montoRecibido` is the difference.
      // Every downstream use of "how much of the received money is left
      // over as anticipo" (Observaciones, `postearAsientoRecibo`'s
      // `montoSinAplicar`) must use this, never `totalAplicadoAhora` itself.
      const cashAplicadoAhora = totalAplicadoAhora - montoDescuentoAhora;
      // 0 in the shortfall case (folded away above) — only positive for a
      // genuine surplus, which only a Manual submission can leave (see the
      // `sobranteSolicitado` guard).
      const sobranteReal = dto.montoRecibido - cashAplicadoAhora;
      const enviarAOtrosIngresos =
        dto.destinoSobrante === 'otros_ingresos' && sobranteReal > 0;

      // Observaciones is redacted from the ACTUAL applications, never
      // whatever the frontend guessed beforehand — Automática mode only
      // learns which documents FIFO touched once `aplicarFifo` above has
      // already run, so this is the earliest point the real text can be
      // known. A caller-supplied `dto.observaciones` always wins verbatim
      // (a Manual submission already sent its own client-composed text; see
      // `recibo-nuevo.tsx`'s `observacionesSugeridas`).
      const camposFrozen: Record<string, unknown> = {};
      if (!dto.observaciones) {
        let generado = redactarObservaciones(
          resumenAplicaciones,
          !enviarAOtrosIngresos && sobranteReal > 0,
        );
        if (diferenciaConfirmada > 0) {
          const nota = `Diferencia de ${diferenciaConfirmada} enviada a Descuentos`;
          generado = generado ? `${generado} — ${nota}` : nota;
        }
        if (enviarAOtrosIngresos) {
          const nota = `Sobrante de ${sobranteReal} enviado a Otros Ingresos`;
          generado = generado ? `${generado} — ${nota}` : nota;
        }
        if (generado) {
          camposFrozen.notes = generado;
        }
      }
      // Frozen alongside `notes` — see `Recibo.otherIncomeAmount`'s own
      // docblock on why this can't be derived later the way a discount can.
      if (enviarAOtrosIngresos) {
        camposFrozen.otherIncomeAmount = sobranteReal;
      }
      if (Object.keys(camposFrozen).length > 0) {
        await this.recibos
          .findOneAndUpdate(
            { _id: creado._id, coPropertyId },
            { $set: camposFrozen },
            { session },
          )
          .exec();
      }

      // ALWAYS posted, never gated on `totalAplicadoAhora > 0` — the cash
      // hit `destinationAccount` for the FULL `montoRecibido` the instant
      // this Recibo was created, whether or not any of it was applied in
      // this same call (design decision, Task 2: a pure anticipo still has
      // an accounting effect — it must reconcile against the bank).
      const reciboActual = await this.recibos
        .findOne({ _id: creado._id, coPropertyId })
        .session(session)
        .exec();
      await this.postearAsientoRecibo(
        session,
        coPropertyId,
        reciboActual!,
        totalAplicadoAhora,
        sobranteReal,
        desglose,
        montoAplicadoMora,
        montoDescuentoAhora,
        descripcionDescuento,
        dto.destinoSobrante,
      );

      if (enviarAOtrosIngresos) {
        // Same reasoning as the shortfall's fold into `montoDescuentoAhora`
        // above, mirrored: money booked as Otros Ingresos in the asiento
        // above must stop being re-appliable as if it were a client
        // anticipo — otherwise it would be counted twice (once as revenue
        // today, once again if someone later applies a Nota de Anticipo
        // against this same recibo).
        await decrementarSaldoDocumentoOrigen(
          this.recibos,
          this.saldoDocumentoOrigen,
          session,
          coPropertyId,
          creado._id,
          sobranteReal,
          'activo',
        );
      }

      const final = await this.recibos
        .findOne({ _id: creado._id, coPropertyId })
        .session(session)
        .exec();
      // "Aplicado" is the full amount CREDITED TO CARTERA — cartera-cash
      // plus whatever discount absorbed the rest (see `anular()`'s own
      // `montoAplicadoCarteraTotal`, the established convention this
      // mirrors: `recibo.appliedAmount` alone is cash-only, same trap).
      // `totalAplicadoAhora` already includes any discount, confirmed or
      // automatic — see its own comment above. Otros Ingresos is deliberately
      // NEVER folded in here — it never touched cartera at all, so it's its
      // own field (`montoOtrosIngresos`, read by `toRecibo` straight off
      // `final.otherIncomeAmount`, just persisted above) instead of being
      // added to "Aplicado", which previously made the two indistinguishable.
      return toRecibo(
        final!,
        totalAplicadoAhora,
        enviarAOtrosIngresos ? 0 : sobranteReal,
      );
    });

    // Frozen presentation record — built once here, outside the transaction
    // above and AFTER it has already committed: a Recibo's own financial
    // correctness never depends on this succeeding. Same frozen-at-emission
    // principle `LotesFacturacionService.consolidar()` already applies to
    // Factura, extended to this document (see `congelarPresentacionRecibo`
    // and `PresentacionDocumento`'s own schema docblock).
    await this.congelarPresentacionRecibo(
      coPropertyId,
      new Types.ObjectId(resultado.id),
    );

    return resultado;
  }

  /**
   * Freezes this Recibo's react-pdf presentation tree into the shared,
   * permanent `presentacion_documento` table — called AFTER `crear()`'s own
   * transaction has already committed (never from inside it: a failure here
   * must never roll back a real financial document). No-ops when any
   * optional dependency it needs is missing (test-only construction — see
   * this class's own canonical-constructor docblock). Wrapped in try/catch,
   * log-and-continue, never rethrown — same placement/reasoning as
   * `LotesFacturacionService.consolidar()`'s identical step for Factura.
   */
  private async congelarPresentacionRecibo(
    coPropertyId: Types.ObjectId,
    reciboId: Types.ObjectId,
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
      const [reciboRaw, aplicacionesActivas, copropiedad] = await Promise.all([
        this.recibos.findOne({ _id: reciboId, coPropertyId }).exec(),
        this.aplicaciones
          .find({
            coPropertyId,
            sourceType: 'RC',
            sourceId: reciboId,
            status: 'activa',
          })
          .sort({ appliedAt: 1 })
          .exec(),
        this.copropiedades.findById(coPropertyId).exec(),
      ]);
      if (!reciboRaw || !copropiedad) return;

      const datos = await construirDatosImpresionRecibo(
        reciboRaw,
        aplicacionesActivas,
        copropiedad,
        coPropertyId,
        {
          facturas: this.facturas,
          notasDebito: this.notasDebito,
          inmuebles: this.inmuebles,
          terceros: this.terceros,
          cuentasContables: this.cuentasContables,
        },
      );

      // Deferred import — `recibo-pdf.ts` pulls in `@react-pdf/renderer`
      // (ESM), which Jest's CJS environment can't load. A static import at
      // the top of this file would make that load happen just from
      // importing `RecibosService` for DI, breaking every spec that
      // references this service even though none of them touch PDFs — same
      // reasoning `LotesFacturacionService.consolidar()` documents for its
      // own identical dynamic import.
      const {
        contenidoRecibo,
      }: typeof import('../../common/pdf/recibo-pdf.js') =
        await import('../../common/pdf/recibo-pdf.js');
      const {
        serializarArbol,
      }: typeof import('../../common/pdf/react/serializar-arbol.js') =
        await import('../../common/pdf/react/serializar-arbol.js');

      await this.presentacionDocumento.guardar(
        'RC',
        reciboRaw._id,
        serializarArbol(contenidoRecibo(datos, copropiedad)),
      );
    } catch (error) {
      this.logger.error(
        `No se pudo congelar documentDefinition para el recibo ${reciboId.toString()} — el recibo ya quedó creado, se puede reintentar aparte.`,
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /**
   * Voids a Recibo, cascading unconditionally: every `activa`
   * AplicacionRecibo it made is reversed, its Factura's
   * `outstandingBalance` is restored — even one already voided through
   * another path, which is harmless bookkeeping and never "reopens" that
   * document (design §6) — and ONE consolidated reversing journal entry is
   * always posted, using the Recibo's OWN cached totals
   * (`appliedAmount`/`unappliedAmount`/`receivedAmount`) rather than
   * replaying every prior call's history (Task 2's corrected accounting
   * design). It is unconditional, unlike the old (buggy) version of this
   * method: `receivedAmount` is always > 0 (DTO validation), so there is
   * always something to reverse — at minimum the original cash entry.
   */
  async anular(
    id: string,
    dto: AnularReciboDto,
    accountId: string,
  ): Promise<ReciboContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // The reversing asiento is dated by the user, never by the server clock
    // — same rule as `crear()`'s own `fechaRecibo` check, same reasoning: an
    // accountant here never works off "today", every document date in the
    // ledger is theirs to declare. A refusal costs no session.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      coPropertyId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la anulación',
    );

    return this.transaccion(async (session) => {
      const reciboDoc = await this.recibos
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!reciboDoc) {
        throw new NotFoundException(`No se encontró el recibo ${id}`);
      }
      if (reciboDoc.status === 'anulado') {
        throw new ConflictException(
          `El recibo ${reciboDoc.fullNumber} ya está anulado`,
        );
      }
      // `appliedAmount`/`unappliedAmount` are no longer live fields on the
      // (now immutable) Recibo — merged in fresh from `SaldoDocumentoOrigen`
      // so the reversing entry below (which reads the Recibo's OWN cached
      // totals) sees the REAL current split, not the frozen creation-time
      // values.
      const saldoOrigenPrevio = await this.saldoDocumentoOrigen
        .findOne({ documentoId: reciboDoc._id })
        .session(session)
        .exec();
      const recibo = Object.assign(reciboDoc, {
        unappliedAmount: saldoOrigenPrevio?.saldoDisponible ?? 0,
        appliedAmount:
          (saldoOrigenPrevio?.montoOriginal ?? 0) -
          (saldoOrigenPrevio?.saldoDisponible ?? 0),
      });

      const aplicacionesActivas = await this.aplicaciones
        .find({
          coPropertyId,
          sourceType: 'RC',
          sourceId: recibo._id,
          status: 'activa',
        })
        .session(session)
        .exec();

      // Mirrors `aplicarManual`'s own two accumulators, in reverse: which
      // specific accounts the reversal must debit BACK (the same ones the
      // original application credited, not the shared cuentaCartera — see
      // `construirContraAsientoCruce`'s `desgloseCartera`), and how much of
      // this void's cuentas-de-orden reversal is actually mora (same
      // `intereses`-kind check `construirMovimientos` uses at facturación).
      const desglose: DesgloseCarteraAplicacion[] = [];
      let montoAplicadoMora = 0;
      let montoDescuentoTotal = 0;

      for (const aplicacion of aplicacionesActivas) {
        // `facturaDoc` is null exactly when this aplicación targeted a Nota
        // Débito instead (never a genuinely missing Factura — nothing
        // financial is ever hard-deleted, see the audit law) — the `else`
        // branch below looks that Nota Débito up instead, for its own
        // documento cruce número.
        const facturaDoc = await this.facturas
          .findOne({ _id: aplicacion.documentId, coPropertyId })
          .session(session)
          .exec();

        if (facturaDoc) {
          // Read BEFORE restoring — `remanentesPorLinea` needs the
          // pre-reversal balance for any línea it still has to legacy-derive
          // (a línea already carrying a real `remainingAmount` ignores this
          // and reads its own tracked value regardless).
          const saldoPrevio = await this.saldoTotalDocumento
            .findOne({ documentoId: facturaDoc._id })
            .session(session)
            .exec();
          const factura = Object.assign(facturaDoc, {
            outstandingBalance: saldoPrevio?.saldoPendiente ?? 0,
          });
          // Replays the EXACT split this application recorded
          // (`detalleConceptos`) instead of re-deriving one via the default
          // cascade — the only way a reversal is correct once the original
          // application could have been a user-chosen manual distribution,
          // not just the cascade (same reasoning `NotaCreditoService.anular()`
          // already applies to its own anchor application's `distribution`).
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
        }

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, coPropertyId },
            { $set: { status: 'revertida', revertedAt: new Date() } },
            { session },
          )
          .exec();

        montoDescuentoTotal += aplicacion.discountApplied ?? 0;
      }

      // ALWAYS posted (no `if (totalRevertido > 0)` gate — that gate was
      // part of the bug this task corrects): uses the Recibo's own cached
      // totals, captured BEFORE the $set below zeroes them, not a sum
      // replayed from the loop above.
      const copropiedad = await this.copropiedades
        .findById(coPropertyId)
        .session(session)
        .exec();
      const cuentaCartera =
        copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaAnticipos =
        copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaDescuentos =
        copropiedad?.discountsCreditAccount ?? CUENTA_SIN_ASIGNAR;
      const desgloseCartera = desglose.map((d) => ({
        account: d.cuenta ?? cuentaCartera,
        monto: d.monto,
        tipoDocumento: d.tipoDocumento,
        numeroDocumento: d.numeroDocumento,
      }));
      // The cartera side to restore is the FULL amount originally credited
      // (cash plus any discount it absorbed) — `recibo.appliedAmount` alone
      // is cash-only (see `crear()`'s own `cashAplicadoAhora`), so the
      // discount this loop just totaled has to be added back. NOT derived
      // by summing `desgloseCartera`: a factura with no matching `lines`
      // (already-edge-case territory `ajustarSaldosCartera` guards against)
      // would leave that sum short of what was actually applied, silently
      // understating the reversal — the Recibo's own cached total is the
      // one number that is always right regardless of what `lines` shows
      // today, months after the original application. `otherIncomeAmount`
      // is subtracted for the same reason `findOne`/`findAll` subtract it:
      // `recibo.appliedAmount` (from `SaldoDocumentoOrigen`) was decremented
      // for it too, but it never touched cartera at all — see below, where
      // it's reversed on the OTHER side of this entry instead.
      const otherIncomeAmount = recibo.otherIncomeAmount ?? 0;
      const montoAplicadoCarteraTotal =
        recibo.appliedAmount - otherIncomeAmount + montoDescuentoTotal;
      // A Recibo never has both a real anticipo leftover AND an Otros
      // Ingresos amount (`crear()`'s `destinoSobrante` is a single choice
      // per document) — whichever is nonzero picks which account/description
      // this reversal's second debit line uses. `otherIncomeAmount === 0`
      // (every Recibo before this feature, and every one that chose
      // Anticipos) reproduces the original, untouched behavior exactly.
      const reversaOtrosIngresos = otherIncomeAmount > 0;
      const cuentaAnticiposReversar = reversaOtrosIngresos
        ? (copropiedad?.otherIncomeCreditAccount ?? CUENTA_SIN_ASIGNAR)
        : cuentaAnticipos;
      const montoAnticiposReversar = reversaOtrosIngresos
        ? otherIncomeAmount
        : recibo.unappliedAmount;
      const descripcionAnticiposReversar = reversaOtrosIngresos
        ? 'Reversión de otros ingresos — anulación de recibo de caja'
        : undefined;
      let entries = construirContraAsientoCruce(
        recibo.destinationAccount,
        cuentaCartera,
        cuentaAnticiposReversar,
        montoAplicadoCarteraTotal,
        montoAnticiposReversar,
        recibo.receivedAmount,
        'RC',
        cuentasOrdenDe(copropiedad),
        desgloseCartera,
        montoAplicadoMora,
        montoDescuentoTotal > 0
          ? { cuenta: cuentaDescuentos, monto: montoDescuentoTotal }
          : undefined,
        undefined,
        descripcionAnticiposReversar,
      );
      entries = await this.conAuxiliares(
        session,
        coPropertyId,
        recibo.inmuebleId,
        copropiedad,
        entries,
      );
      await this.asientos.create(
        [
          {
            coPropertyId,
            loteId: null,
            facturaId: null,
            reciboId: recibo._id,
            // The date the user declared for THIS anulación (validated
            // above, before the transaction opened) — never `new Date()`.
            // `voidedAt` below stays the real audit instant on purpose: the
            // business date and the "when it was actually recorded" trail
            // are never the same field.
            date: new Date(dto.fecha),
            entries,
          },
        ],
        { session },
      );

      // Once voided, a Recibo offers no anticipo and shows no applied
      // amount — every AplicacionRecibo it made is now `revertida`, so
      // appliedAmount is legitimately 0; unappliedAmount is set to 0 too
      // (not receivedAmount) so a stale `unappliedAmount > 0` query can
      // never surface a voided receipt as available anticipo without also
      // checking `estado` (design §6 does not specify this; documented
      // here as the deliberate choice).
      await this.recibos
        .findOneAndUpdate(
          { _id: id, coPropertyId },
          {
            $set: {
              status: 'anulado',
              voidedReason: dto.motivo,
              voidedDetail: dto.detalle,
              voidedAt: new Date(),
              // Same $set as the rest of the void so the actor can never be
              // written without the state transition, or the other way round.
              voidedBy: accountId,
              appliedAmount: 0,
              unappliedAmount: 0,
            },
          },
          { session },
        )
        .exec();
      // The REAL live balance — `SaldoDocumentoOrigen`, per this class's own
      // constructor docblock — goes to zero too, same "no anticipo, no
      // applied amount" outcome as the `$set` above.
      await this.saldoDocumentoOrigen
        .updateOne(
          { documentoId: id },
          { $set: { saldoDisponible: 0 } },
          { session },
        )
        .exec();

      const final = await this.recibos
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toRecibo(final!, 0, 0);
    });
  }

  /**
   * Lean listing (design §5, `GET /recibos`) — always scoped to the active
   * copropiedad, honoring `ListarRecibosDto`'s filters (`inmuebleId`,
   * `estado`, date range, and `conAnticipoDisponible` as
   * `unappliedAmount > 0`, Task 5). Uses `toRecibo`, never
   * `toReciboDetalle` — no per-row `AplicacionRecibo` lookup here, unlike
   * `findOne` below.
   */
  async findAll(query: ListarRecibosDto): Promise<Paginado<ReciboContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;
    if (query.conAnticipoDisponible) {
      // No longer a field on Recibo itself — resolve candidate ids from
      // `SaldoDocumentoOrigen` first (see that schema's own docblock), same
      // pattern `FacturasService.findAll` already uses on the charge side.
      const conSaldo = await this.saldoDocumentoOrigen
        .find({
          coPropertyId,
          tipoDocumento: 'RC',
          saldoDisponible: { $gt: 0 },
        })
        .exec();
      filtro._id = { $in: conSaldo.map((s) => s.documentoId) };
    }
    if (query.desde || query.hasta) {
      filtro.receivedDate = {
        ...(query.desde ? { $gte: new Date(query.desde) } : {}),
        ...(query.hasta ? { $lte: new Date(query.hasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.recibos
        .find(filtro)
        .sort({ number: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.recibos.countDocuments(filtro).exec(),
    ]);

    const ids = documentos.map((d) => d._id);
    const [saldos, aplicacionesActivas] = await Promise.all([
      ids.length
        ? this.saldoDocumentoOrigen.find({ documentoId: { $in: ids } }).exec()
        : [],
      // Same discount-add-back this module's own `anular()`/`findOne` already
      // document — `SaldoDocumentoOrigen` only tracks cash, so a discount
      // (automatic or a confirmed shortfall) has to be summed back in
      // separately for "Aplicado" to match what each document actually saw.
      ids.length
        ? this.aplicaciones
            .find({
              coPropertyId,
              sourceType: 'RC',
              sourceId: { $in: ids },
              status: 'activa',
            })
            .exec()
        : [],
    ]);
    const saldoPorDocumento = new Map(
      saldos.map((s) => [
        s.documentoId.toString(),
        { montoOriginal: s.montoOriginal, saldoDisponible: s.saldoDisponible },
      ]),
    );
    const descuentoPorRecibo = new Map<string, number>();
    for (const a of aplicacionesActivas) {
      const clave = a.sourceId.toString();
      descuentoPorRecibo.set(
        clave,
        (descuentoPorRecibo.get(clave) ?? 0) + a.discountApplied,
      );
    }

    return {
      items: documentos.map((doc) => {
        const idDoc = doc._id.toString();
        const saldo = saldoPorDocumento.get(idDoc);
        const unappliedAmount = saldo?.saldoDisponible ?? 0;
        const appliedAmountCash = saldo
          ? saldo.montoOriginal - saldo.saldoDisponible
          : 0;
        // Subtract `otherIncomeAmount` for the same reason `findOne` does —
        // `doc` already carries it, no extra query needed.
        const appliedAmount =
          appliedAmountCash -
          (doc.otherIncomeAmount ?? 0) +
          (descuentoPorRecibo.get(idDoc) ?? 0);
        return toRecibo(doc, appliedAmount, unappliedAmount);
      }),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Full detail (design §5, `GET /recibos/:id`) — includes the
   * `aplicaciones` array via a separate query against `AplicacionRecibo`,
   * assembled through `toReciboDetalle` (Task 3).
   */
  async findOne(id: string): Promise<ReciboDetalle> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const recibo = await this.recibos.findOne({ _id: id, coPropertyId }).exec();
    if (!recibo) {
      throw new NotFoundException(`No se encontró el recibo ${id}`);
    }
    const saldoOrigen = await this.saldoDocumentoOrigen
      .findOne({ documentoId: recibo._id })
      .exec();
    const unappliedAmount = saldoOrigen?.saldoDisponible ?? 0;
    const appliedAmountCash = saldoOrigen
      ? saldoOrigen.montoOriginal - saldoOrigen.saldoDisponible
      : 0;
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, sourceType: 'RC', sourceId: recibo._id })
      .sort({ appliedAt: 1 })
      .exec();
    // Same convention `anular()` already documents on its own
    // `montoAplicadoCarteraTotal`: `appliedAmount` (from `SaldoDocumentoOrigen`)
    // is cash-only — a discount (automatic pronto pago, or a confirmed
    // shortfall) credited MORE to cartera than cash actually moved, so it has
    // to be added back for "Aplicado" to match what each document's own
    // `AplicacionCartera.amountApplied` row shows. `otherIncomeAmount` has to
    // be SUBTRACTED for the opposite reason: `SaldoDocumentoOrigen` was
    // decremented for it too (so it stays out of future anticipo
    // reapplication), but it never touched cartera — it's `montoOtrosIngresos`
    // on the contract, not part of "Aplicado" (see `crear()`'s own note).
    const appliedAmount =
      appliedAmountCash -
      (recibo.otherIncomeAmount ?? 0) +
      aplicaciones
        .filter((a) => a.status === 'activa')
        .reduce((acc, a) => acc + a.discountApplied, 0);

    // Batch-resolve each application's target document's own printed
    // number ("FV-1") for display — this row only stores `documentId`.
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
    for (const nd of notasDebitoDoc) {
      numerosPorDocumento.set(nd._id.toString(), nd.fullNumber);
    }

    // Also the frontend's source for rendering this Recibo's PDF
    // client-side — frozen once by `congelarPresentacionRecibo`, read back
    // here the same way `FacturasService.findOne` reads its own
    // `documentDefinition`. `null` for a receipt whose creation ran before
    // this field existed, or whose presentation-cache step failed.
    const documentDefinition = this.presentacionDocumento
      ? await this.presentacionDocumento.buscar('RC', recibo._id)
      : null;

    return toReciboDetalle(
      recibo,
      appliedAmount,
      unappliedAmount,
      aplicaciones,
      numerosPorDocumento,
      documentDefinition,
    );
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation.
   */
  async findOneRaw(id: string): Promise<ReciboDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const recibo = await this.recibos.findOne({ _id: id, coPropertyId }).exec();
    if (!recibo) {
      throw new NotFoundException(`No se encontró el recibo ${id}`);
    }
    return recibo;
  }

  /**
   * Returns active applications for a source document (RC or NC).
   * Used by PDF generation to show application lines.
   */
  async findAplicacionesForSource(
    sourceType: 'RC' | 'NC',
    sourceId: Types.ObjectId,
  ): Promise<AplicacionCarteraDocument[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.aplicaciones
      .find({ coPropertyId, sourceType, sourceId, status: 'activa' })
      .sort({ appliedAt: 1 })
      .exec();
  }

  /**
   * Applies `solicitadas` against their documents — ALL of them, or none.
   * Thin wrapper: the actual logic lives in `ejecutarAplicacionManual`
   * (`cruce.util.ts`), extracted so `NotasAnticipoService` can run the
   * identical cruce against the same `unappliedAmount`, just recorded under
   * a Nota de Anticipo (`sourceType: 'NA'`) instead of the Recibo itself.
   */
  private async aplicarManual(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    recibo: ReciboDocument,
    solicitadas: AplicacionSolicitadaDto[],
    accountId: string,
    descuentoConfirmadoExtra = 0,
  ): Promise<{
    creadas: AplicacionCarteraDocument[];
    desglose: DesgloseCarteraAplicacion[];
    montoAplicadoMora: number;
    resumen: ResumenAplicacion[];
    montoDescuentoTotal: number;
  }> {
    return ejecutarAplicacionManual(
      {
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
        sourceType: 'RC',
        sourceId: recibo._id,
        sourceDate: recibo.receivedDate,
        accountId,
      },
      solicitadas,
      descuentoConfirmadoExtra,
    );
  }

  /**
   * Walks the inmueble's open Facturas AND open Notas Débito, merged into
   * one oldest-first queue, applying until `montoDisponible` is exhausted or
   * there is nothing left open. Thin wrapper: the actual logic lives in
   * `ejecutarAplicacionFifo` (`cruce.util.ts`) — see `aplicarManual`'s
   * identical note on why this was extracted.
   */
  private async aplicarFifo(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    recibo: ReciboDocument,
    montoDisponible: number,
    accountId: string,
  ): Promise<{
    aplicadas: AplicacionCarteraDocument[];
    errores: ErrorAplicacion[];
    montoSinAplicar: number;
    desglose: DesgloseCarteraAplicacion[];
    montoAplicadoMora: number;
    resumen: ResumenAplicacion[];
    montoDescuentoTotal: number;
  }> {
    return ejecutarAplicacionFifo(
      {
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
        sourceType: 'RC',
        sourceId: recibo._id,
        sourceDate: recibo.receivedDate,
        accountId,
      },
      montoDisponible,
    );
  }

  /**
   * Enriches `entries` with tercero/centroCosto/flujoCaja right before
   * `this.asientos.create(...)`, same call-site shape every asiento-posting
   * service uses (see `enriquecerMovimientosConAuxiliares`'s own docblock).
   * `tercero` is the inmueble's OWN unit code — Recibos has no unitCode
   * frozen on itself, so this is the one extra lookup (`this.inmuebles`)
   * every other caller of this helper's sibling in `lotes.service.ts`
   * doesn't need (a Factura's own `preliminar.unitCode` is already at hand
   * there). Returns `entries` untouched when `cuentasContables` was never
   * injected — the test-only case documented on this class's constructor.
   */
  private async conAuxiliares(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    copropiedad: {
      defaultCostCentre: string | null;
      cashFlowCode: string | null;
    } | null,
    entries: ReturnType<typeof construirAsientoCruce>,
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
    });
  }

  /**
   * Posts the CREATION-time journal entry: always one debit to
   * `recibo.destinationAccount` for the full `montoAplicado + montoSinAplicar`
   * (= `receivedAmount`), and one or two credits splitting between
   * `cuentaCartera` (whatever was applied in this same `crear()` call) and
   * `cuentaAnticipos` (whatever remains as anticipo) — see the corrected
   * accounting design on Task 2. Called unconditionally by `crear()`, even
   * when `montoAplicado` is 0 (a pure anticipo still moves real cash).
   */
  private async postearAsientoRecibo(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    recibo: ReciboDocument,
    montoAplicado: number,
    montoSinAplicar: number,
    desglose: DesgloseCarteraAplicacion[],
    montoAplicadoMora: number,
    montoDescuento: number,
    // Set only when part (or all) of `montoDescuento` came from a
    // user-confirmed payment shortfall, not the automatic early-payment
    // discount — see `crear()`'s own `diferenciaConfirmada`. Wording must
    // not claim "pronto pago" when it wasn't.
    descripcionDescuento?: string,
    // User-confirmed destination for a payment SURPLUS (manual mode only
    // — see `CrearReciboDto.destinoSobrante`'s own docblock). `undefined`/
    // `'anticipo'` reproduces today's only behavior; `'otros_ingresos'`
    // credits `otherIncomeCreditAccount` instead of `advancesAccount`, with
    // its own description — `crear()` is what actually stops that money
    // from staying re-appliable (`SaldoDocumentoOrigen`), this method only
    // decides which account the journal entry credits.
    destinoSobrante?: 'anticipo' | 'otros_ingresos',
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos =
      destinoSobrante === 'otros_ingresos'
        ? (copropiedad?.otherIncomeCreditAccount ?? CUENTA_SIN_ASIGNAR)
        : (copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR);
    const descripcionAnticipo =
      destinoSobrante === 'otros_ingresos'
        ? 'Otros ingresos — recibo de caja'
        : undefined;
    const cuentaDescuentos =
      copropiedad?.discountsDebitAccount ?? CUENTA_SIN_ASIGNAR;
    // `cuenta: null` (no accountingReceivableAccount for that concepto, or a
    // Nota Débito application) resolves to the coproperty's shared
    // cuentaCartera.
    const desgloseCartera = desglose.map((d) => ({
      account: d.cuenta ?? cuentaCartera,
      monto: d.monto,
      tipoDocumento: d.tipoDocumento,
      numeroDocumento: d.numeroDocumento,
    }));
    let entries = construirAsientoCruce(
      recibo.destinationAccount,
      cuentaCartera,
      cuentaAnticipos,
      montoAplicado,
      montoSinAplicar,
      'RC',
      cuentasOrdenDe(copropiedad),
      desgloseCartera,
      montoAplicadoMora,
      montoDescuento > 0
        ? { cuenta: cuentaDescuentos, monto: montoDescuento }
        : undefined,
      undefined,
      descripcionDescuento,
      descripcionAnticipo,
    );
    entries = await this.conAuxiliares(
      session,
      coPropertyId,
      recibo.inmuebleId,
      copropiedad,
      entries,
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: recibo._id,
          date: recibo.receivedDate,
          entries,
        },
      ],
      { session },
    );
  }
}
