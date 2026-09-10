import {
  BadRequestException,
  ConflictException,
  Injectable,
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
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  actualizarRemanentesLinea,
  ajustarSaldosCarteraPorDistribucion,
  ejecutarAplicacionFifo,
  ejecutarAplicacionManual,
  remanentesPorLinea,
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
 */
@Injectable()
export class RecibosService {
  constructor(
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
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
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables?: Model<CuentaContableDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles?: Model<InmuebleDocument>,
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
    if (sumaSolicitada > dto.montoRecibido) {
      throw new BadRequestException(
        `La suma de las aplicaciones (${sumaSolicitada}) no puede superar ` +
          `el monto recibido (${dto.montoRecibido})`,
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

    return this.transaccion(async (session) => {
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
            appliedAmount: 0,
            unappliedAmount: dto.montoRecibido,
            status: 'activo',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      let totalAplicadoAhora = 0;
      let creditosPorCuenta = new Map<string | null, number>();
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
        );
        totalAplicadoAhora = resultado.creadas.reduce(
          (acc, a) => acc + a.amountApplied,
          0,
        );
        creditosPorCuenta = resultado.creditosPorCuenta;
        montoAplicadoMora = resultado.montoAplicadoMora;
        resumenAplicaciones = resultado.resumen;
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
        creditosPorCuenta = resultado.creditosPorCuenta;
        montoAplicadoMora = resultado.montoAplicadoMora;
        resumenAplicaciones = resultado.resumen;
        montoDescuentoAhora = resultado.montoDescuentoTotal;
      }

      // `totalAplicadoAhora` already includes any early-payment discount
      // summed in (see `evaluarAplicacionConDescuento`, cruce.util.ts) — the
      // real cash this call drew from `montoRecibido` is the difference.
      // Every downstream use of "how much of the received money is left
      // over as anticipo" (Observaciones, `postearAsientoRecibo`'s
      // `montoSinAplicar`) must use this, never `totalAplicadoAhora` itself.
      const cashAplicadoAhora = totalAplicadoAhora - montoDescuentoAhora;

      // Observaciones is redacted from the ACTUAL applications, never
      // whatever the frontend guessed beforehand — Automática mode only
      // learns which documents FIFO touched once `aplicarFifo` above has
      // already run, so this is the earliest point the real text can be
      // known. A caller-supplied `dto.observaciones` always wins verbatim
      // (a Manual submission already sent its own client-composed text; see
      // `recibo-nuevo.tsx`'s `observacionesSugeridas`).
      if (!dto.observaciones) {
        const generado = redactarObservaciones(
          resumenAplicaciones,
          dto.montoRecibido - cashAplicadoAhora > 0,
        );
        if (generado) {
          await this.recibos
            .findOneAndUpdate(
              { _id: creado._id, coPropertyId },
              { $set: { notes: generado } },
              { session },
            )
            .exec();
        }
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
        dto.montoRecibido - cashAplicadoAhora,
        creditosPorCuenta,
        montoAplicadoMora,
        montoDescuentoAhora,
      );

      const final = await this.recibos
        .findOne({ _id: creado._id, coPropertyId })
        .session(session)
        .exec();
      return toRecibo(final!);
    });
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
      const recibo = await this.recibos
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!recibo) {
        throw new NotFoundException(`No se encontró el recibo ${id}`);
      }
      if (recibo.status === 'anulado') {
        throw new ConflictException(
          `El recibo ${recibo.fullNumber} ya está anulado`,
        );
      }

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
      const creditosPorCuenta = new Map<string | null, number>();
      const acumular = (cuenta: string | null, monto: number) => {
        if (monto === 0) return;
        creditosPorCuenta.set(
          cuenta,
          (creditosPorCuenta.get(cuenta) ?? 0) + monto,
        );
      };
      let montoAplicadoMora = 0;
      let montoDescuentoTotal = 0;

      for (const aplicacion of aplicacionesActivas) {
        // Unconditional, plain $inc — never guarded by
        // decrementarSaldoFactura's floor (that guard exists to stop
        // OVER-application, not to gate a reversal). `factura` is null when
        // the document was removed/voided through another path; the
        // reversal proceeds regardless (design §6).
        const factura = await this.facturas
          .findOneAndUpdate(
            { _id: aplicacion.documentId, coPropertyId },
            { $inc: { outstandingBalance: aplicacion.amountApplied } },
            { new: true, session },
          )
          .exec();

        if (factura) {
          // Replays the EXACT split this application recorded
          // (`detalleConceptos`) instead of re-deriving one via the default
          // cascade — the only way a reversal is correct once the original
          // application could have been a user-chosen manual distribution,
          // not just the cascade (same reasoning `NotaCreditoService.anular()`
          // already applies to its own anchor application's `distribution`).
          //
          // `factura` here already reflects the $inc above (outstandingBalance
          // restored UP) — for a línea `remanentesPorLinea` still has to
          // legacy-derive (never touched by a manual distribution), that
          // function needs the state as it stood BEFORE this reversal, so
          // the aggregate is walked back by exactly what this reversal is
          // about to give back (a línea already carrying a real
          // `remainingAmount` ignores this and reads its own tracked value
          // regardless).
          const remanentesAntes = remanentesPorLinea({
            ...factura,
            outstandingBalance:
              factura.outstandingBalance - aplicacion.amountApplied,
          });
          const partes = await ajustarSaldosCarteraPorDistribucion(
            this.saldos,
            session,
            coPropertyId,
            factura.inmuebleId,
            aplicacion.detalleConceptos.map((d) => ({
              conceptoId: d.conceptoId,
              monto: d.monto,
            })),
            aplicacion.amountApplied,
            1,
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
            acumular(linea?.accountingReceivableAccount ?? null, parte.parte);
            if (linea?.conceptKind === 'intereses') {
              montoAplicadoMora += parte.parte;
            }
          }
        } else {
          acumular(null, aplicacion.amountApplied);
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
      const desgloseCartera = Array.from(creditosPorCuenta.entries()).map(
        ([cuenta, monto]) => ({ account: cuenta ?? cuentaCartera, monto }),
      );
      // The cartera side to restore is the FULL amount originally credited
      // (cash plus any discount it absorbed) — `recibo.appliedAmount` alone
      // is cash-only (see `crear()`'s own `cashAplicadoAhora`), so the
      // discount this loop just totaled has to be added back. NOT derived
      // by summing `desgloseCartera`: a factura with no matching `lines`
      // (already-edge-case territory `ajustarSaldosCartera` guards against)
      // would leave that sum short of what was actually applied, silently
      // understating the reversal — the Recibo's own cached total is the
      // one number that is always right regardless of what `lines` shows
      // today, months after the original application.
      const montoAplicadoCarteraTotal =
        recibo.appliedAmount + montoDescuentoTotal;
      let entries = construirContraAsientoCruce(
        recibo.destinationAccount,
        cuentaCartera,
        cuentaAnticipos,
        montoAplicadoCarteraTotal,
        recibo.unappliedAmount,
        recibo.receivedAmount,
        'RC',
        cuentasOrdenDe(copropiedad),
        desgloseCartera,
        montoAplicadoMora,
        montoDescuentoTotal > 0
          ? { cuenta: cuentaDescuentos, monto: montoDescuentoTotal }
          : undefined,
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

      const final = await this.recibos
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toRecibo(final!);
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
    if (query.conAnticipoDisponible) filtro.unappliedAmount = { $gt: 0 };
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

    return { items: documentos.map(toRecibo), total, pagina, porPagina };
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
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, sourceType: 'RC', sourceId: recibo._id })
      .sort({ appliedAt: 1 })
      .exec();

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

    return toReciboDetalle(recibo, aplicaciones, numerosPorDocumento);
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
  ): Promise<{
    creadas: AplicacionCarteraDocument[];
    creditosPorCuenta: Map<string | null, number>;
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
        recibos: this.recibos,
        session,
        coPropertyId,
        recibo,
        sourceType: 'RC',
        sourceId: recibo._id,
        accountId,
      },
      solicitadas,
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
    creditosPorCuenta: Map<string | null, number>;
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
        recibos: this.recibos,
        session,
        coPropertyId,
        recibo,
        sourceType: 'RC',
        sourceId: recibo._id,
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
    creditosPorCuenta: Map<string | null, number>,
    montoAplicadoMora: number,
    montoDescuento: number,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaDescuentos =
      copropiedad?.discountsDebitAccount ?? CUENTA_SIN_ASIGNAR;
    // null key (no accountingReceivableAccount for that concepto, or a Nota
    // Débito application) resolves to the coproperty's shared cuentaCartera.
    const desgloseCartera = Array.from(creditosPorCuenta.entries()).map(
      ([cuenta, monto]) => ({ account: cuenta ?? cuentaCartera, monto }),
    );
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
