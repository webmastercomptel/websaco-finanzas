import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  claveMesDe,
  type CandidatoAplicacionLote,
  type DatosBatchAplicacionLote,
  type DatosInmuebleParaAplicacionLote,
  type EscrituraFilaAplicacionLote,
} from './aplicacion-lote-batch.util';
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
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import type { NumeroAsignado } from '../../common/numeracion/numeracion.service';
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  actualizarRemanentesLinea,
  ajustarSaldosCarteraPorDistribucion,
  cuentaCarteraDeLinea,
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
import { TituloDocumentoService } from '../../common/documentos/titulo-documento.service';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';
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

export interface ContextoCreacionRecibo {
  copropiedadId: Types.ObjectId;
  destinationAccount: string;
  diferenciaConfirmada: number;
}

/**
 * Redacts "Cancela facturas 6, 173, 340 y genera anticipo" / "Abona a
 * factura 341" from the applications a `crear()` call actually made — the
 * single source of truth for both Automática (FIFO, decided entirely
 * server-side) and Manual (the client already composes an equivalent
 * preview from its own selections, but the server-computed text still wins
 * whenever the caller left `observaciones` blank, so both paths render
 * identically). Mirrors `recibo-nuevo.tsx`'s `observacionesSugeridas`
 * formatting exactly: bare document numbers (never the prefixed
 * `numeroCompleto`), comma-only joins (no "y" before the last one — that "y" is
 * reserved for chaining "genera anticipo"), grouped Cancela-antes-que-Abona,
 * Facturas-antes-que-Notas-Débito.
 */
export const redactarObservaciones = (
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
  const saldosInicialesCancelados = resumen
    .filter((r) => r.tipo === 'SI' && r.completa)
    .map((r) => r.numero);
  const saldosInicialesAbonados = resumen
    .filter((r) => r.tipo === 'SI' && !r.completa)
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
    clausula(
      'Cancela',
      'saldo inicial',
      'saldos iniciales',
      saldosInicialesCancelados,
    ),
    clausula(
      'Abona a',
      'saldo inicial',
      'saldos iniciales',
      saldosInicialesAbonados,
    ),
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
 * full `montoRecibido` must always be booked (debited to
 * `cuentaDestino`) the moment a Recibo is created, whether or not any of
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
 * Débito's own `saldoPendiente` (via `decrementarSaldoNotaDebito`),
 * since `AplicacionCartera.tipoDocumento` admits `'ND'` as a target and a
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
 * was: `Recibo.montoAplicado`/`montoSinAplicar` are no longer live fields on
 * the (now immutable) document — `SaldoDocumentoOrigen` is where
 * `decrementarSaldoDocumentoOrigen`/`restaurarSaldoDocumentoOrigen` now read
 * and write that balance (see that schema's own docblock).
 *
 * `terceros` and `presentacionDocumento` were APPENDED, trailing and
 * optional (same reasoning as `cuentasContables`/`inmuebles` right above).
 * Originally added so `crear()` could freeze this Recibo's own
 * `documentDefinition` right after creating it — that step is GONE under
 * the pdfmake + frontend-render model (`solicitar-generacion`/
 * `confirmar-generacion` are separate, explicit actions the frontend
 * triggers later, from `RecibosController`). `terceros` now backs
 * `datosImpresion` (`construirDatosImpresionRecibo`'s own
 * `modelos.terceros`) and `presentacionDocumento` backs `findOne`'s
 * `objectPath`/`generatedAt` lookup; every existing positional test keeps
 * compiling with both left `undefined`.
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
    // APPENDED LAST, optional — see the class docblock's own append
    // discipline. Optional (unlike every other model here) so the many
    // existing hand-rolled-mock tests that stop their positional argument
    // list before this one keep compiling; `ejecutarAplicacionFifo`
    // (cruce.util.ts) treats "not provided" as "no Saldos Iniciales exist
    // for this tenant" (an empty candidate list), never a crash — real
    // requests always get it from Nest's own DI.
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales?: Model<SaldoInicialDocument>,
    // APPENDED LAST, optional — same append discipline as every dependency
    // above. Backs `datosImpresion`'s own `resolverGenerico('RC', ...)` call.
    private readonly tituloDocumento?: TituloDocumentoService,
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
   * Everything `crear()` must validate/resolve BEFORE opening a transaction
   * — mutual-exclusivity of aplicación manual/automática, the period and
   * billing-period locks, and `destinationAccount` resolution. Pure reads
   * and validation, no writes; extracted so the batch path
   * (`LoteRecibosService.ejecutarAplicacion`) can run it once per row
   * BEFORE it opens its own shared per-tanda transaction, exactly mirroring
   * where `crear()` itself runs this today (outside any transaction).
   *
   * `copropiedadId` is the CALLER's job to resolve, never this method's —
   * `crear()` below resolves it from CLS right before calling, exactly as
   * it always has; `LoteRecibosService.ejecutarAplicacion` resolves it
   * once on the HTTP request thread (before it ever enqueues anything) and
   * threads it through the whole batch job instead. Neither this method
   * nor `resolverInmuebleCodigo` ever call `TenantContextService`
   * themselves anymore — they used to, which broke the moment the batch
   * path started running for real inside a BullMQ job
   * (`AplicacionLoteRecibosProcessor`): CLS is only ever populated by HTTP
   * middleware (`ClsModule.forRoot({ middleware: { mount: true } })`),
   * never inside a queued job, so `resolveCoPropertyId()` threw "No hay
   * una copropiedad activa" unconditionally in there — a real bug, found
   * live in production on `POST /lotes-recibos/:id/aplicar`.
   */
  async prepararCreacion(
    dto: CrearReciboDto,
    copropiedadId: Types.ObjectId,
  ): Promise<ContextoCreacionRecibo> {
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
      copropiedadId.toString(),
      new Date(dto.fechaRecibo),
    );
    // The payment date must fall in the same month/year as the last
    // consolidated billing run — a Recibo dated outside the current
    // billing period reads as paying a period that hasn't been (or is no
    // longer being) billed. A coproperty that has never consolidated a
    // lote has no "current period" yet, so nothing to validate against.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      copropiedadId.toString(),
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
    await this.lotes.exigirSinLoteAbierto(copropiedadId.toString());

    const destinationAccount =
      dto.cuentaDestino ??
      (await this.copropiedades.findById(copropiedadId).exec())
        ?.cuentaBancariaDefecto;
    if (!destinationAccount) {
      throw new BadRequestException(
        'La cuenta destino es requerida cuando no hay cuenta predeterminada en la copropiedad.',
      );
    }

    return { copropiedadId, destinationAccount, diferenciaConfirmada };
  }

  /** `claveMesDe("2026-06")` back to a real `Date` inside that month — any
   *  day works, `PeriodoService.estaAbierto` only reads year/month off it
   *  (`periodoDe`, same local-time reasoning that produced the key). */
  private fechaDeClaveMes(clave: string): Date {
    const [year, month] = clave.split('-').map(Number);
    return new Date(year, month - 1, 1);
  }

  /**
   * Everything `ejecutarAplicacion()`'s batch-lote path needs, read ONCE
   * for the WHOLE lote instead of once per row — design §4. Mirrors, but
   * never calls, `prepararCreacion`'s own reads: `lotes.exigirSinLoteAbierto`
   * (still throws and aborts before any tanda starts — a refusal costs no
   * session, same placement `prepararCreacion` already uses),
   * `lotes.obtenerUltimoConsolidado`, and `periodo.estaAbierto` (this
   * method's non-throwing twin of `prepararCreacion`'s
   * `periodo.exigirAbierto`, resolved per DISTINCT month instead of per
   * row). Candidate documents (Facturas/Notas Débito/Saldos Iniciales) are
   * fetched via `$in` across EVERY inmueble in the lote, then
   * cross-referenced against `SaldoTotalDocumento` for a positive balance
   * — same two-step `ejecutarAplicacionFifo` already does per inmueble,
   * just widened to the whole batch.
   */
  async leerDatosBatchAplicacionLote(
    copropiedadId: Types.ObjectId,
    inmuebleIds: Types.ObjectId[],
    fechasPago: Date[],
  ): Promise<DatosBatchAplicacionLote> {
    await this.lotes.exigirSinLoteAbierto(copropiedadId.toString());

    const mesesDistintos = [...new Set(fechasPago.map((f) => claveMesDe(f)))];

    const [
      inmuebles,
      facturas,
      notasDebito,
      saldosIniciales,
      copropiedad,
      cuentasContables,
      ultimoLoteFacturacion,
      periodosAbiertos,
    ] = await Promise.all([
      this.inmuebles!.find({ copropiedadId, _id: { $in: inmuebleIds } }).exec(),
      this.facturas
        .find({
          copropiedadId,
          inmuebleId: { $in: inmuebleIds },
          estado: 'emitida',
        })
        .exec(),
      this.notasDebito
        .find({
          copropiedadId,
          inmuebleId: { $in: inmuebleIds },
          estado: 'emitida',
        })
        .exec(),
      this.saldosIniciales
        ? this.saldosIniciales
            .find({
              copropiedadId,
              inmuebleId: { $in: inmuebleIds },
              estado: 'activo',
            })
            .exec()
        : Promise.resolve([]),
      this.copropiedades.findById(copropiedadId).exec(),
      this.cuentasContables!.find({ copropiedadId }).exec(),
      this.lotes.obtenerUltimoConsolidado(copropiedadId.toString()),
      Promise.all(
        mesesDistintos.map((clave) =>
          this.periodo.estaAbierto(
            copropiedadId.toString(),
            this.fechaDeClaveMes(clave),
          ),
        ),
      ),
    ]);

    const idsDocumentos = [
      ...facturas.map((f) => f._id),
      ...notasDebito.map((n) => n._id),
      ...saldosIniciales.map((s) => s._id),
    ];
    const saldosTotales = idsDocumentos.length
      ? await this.saldoTotalDocumento
          .find({
            documentoId: { $in: idsDocumentos },
            saldoPendiente: { $gt: 0 },
          })
          .exec()
      : [];
    const saldoPorDocumentoGlobal = new Map(
      saldosTotales.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );

    const cuentasContablesPorCodigo = new Map(
      cuentasContables.map((c) => [
        c.codigo,
        {
          requiereTercero: c.requiereTercero,
          centroUtilidad: c.centroUtilidad,
          centroDestino: c.centroDestino,
          flujoCaja: c.flujoCaja,
          requiereDocumentoCruce: c.requiereDocumentoCruce,
        },
      ]),
    );
    const periodoAbiertoPorMes = new Map(
      mesesDistintos.map((clave, i) => [clave, periodosAbiertos[i]]),
    );

    const indicePorInmueble = new Map<
      string,
      DatosInmuebleParaAplicacionLote
    >();
    for (const inmueble of inmuebles) {
      const facturasAbiertas = facturas
        .filter(
          (f) =>
            f.inmuebleId.equals(inmueble._id) &&
            saldoPorDocumentoGlobal.has(f._id.toString()),
        )
        .sort(
          (a, b) =>
            (a.fechaVencimiento ?? a.fechaEmision).getTime() -
            (b.fechaVencimiento ?? b.fechaEmision).getTime(),
        );
      const notasDebitoAbiertas = notasDebito
        .filter(
          (n) =>
            n.inmuebleId.equals(inmueble._id) &&
            saldoPorDocumentoGlobal.has(n._id.toString()),
        )
        .sort((a, b) => a.fechaEmision.getTime() - b.fechaEmision.getTime());
      const saldosInicialesAbiertos = saldosIniciales
        .filter(
          (s) =>
            s.inmuebleId.equals(inmueble._id) &&
            saldoPorDocumentoGlobal.has(s._id.toString()),
        )
        .sort(
          (a, b) => a.fechaVencimiento.getTime() - b.fechaVencimiento.getTime(),
        );

      const prioridadDe = (c: CandidatoAplicacionLote): Date =>
        c.tipo === 'FV'
          ? (c.doc.fechaVencimiento ?? c.doc.fechaEmision)
          : c.tipo === 'ND'
            ? c.doc.fechaEmision
            : c.doc.fechaVencimiento;

      const candidatosOrdenados: CandidatoAplicacionLote[] = [
        ...facturasAbiertas.map((doc): CandidatoAplicacionLote => ({
          tipo: 'FV',
          doc,
        })),
        ...notasDebitoAbiertas.map((doc): CandidatoAplicacionLote => ({
          tipo: 'ND',
          doc,
        })),
        ...saldosInicialesAbiertos.map((doc): CandidatoAplicacionLote => ({
          tipo: 'SI',
          doc,
        })),
      ].sort((a, b) => {
        const porFecha = prioridadDe(a).getTime() - prioridadDe(b).getTime();
        if (porFecha !== 0) return porFecha;
        return a.doc._id.toString().localeCompare(b.doc._id.toString());
      });

      const saldoPorDocumento = new Map<string, number>();
      for (const { doc } of candidatosOrdenados) {
        saldoPorDocumento.set(
          doc._id.toString(),
          saldoPorDocumentoGlobal.get(doc._id.toString())!,
        );
      }

      indicePorInmueble.set(inmueble._id.toString(), {
        inmueble: {
          _id: inmueble._id,
          holderId: inmueble.titularId,
          code: inmueble.codigo,
        },
        candidatosOrdenados,
        saldoPorDocumento,
      });
    }

    return {
      indicePorInmueble,
      copropiedad: copropiedad
        ? {
            cuentaContableCartera: copropiedad.cuentaContableCartera,
            cuentaAnticipos: copropiedad.cuentaAnticipos,
            descuentosCuentaDebito: copropiedad.descuentosCuentaDebito,
            usaCuentasOrden: copropiedad.usaCuentasOrden,
            cuentaOrdenDebito: copropiedad.cuentaOrdenDebito,
            cuentaOrdenCredito: copropiedad.cuentaOrdenCredito,
            centroCostoDefecto: copropiedad.centroCostoDefecto,
            flujoCajaCodigo: copropiedad.flujoCajaCodigo,
            cuentaBancariaDefecto: copropiedad.cuentaBancariaDefecto,
          }
        : null,
      cuentasContablesPorCodigo,
      periodoAbiertoPorMes,
      ultimoLoteFacturacion: ultimoLoteFacturacion
        ? {
            periodoDesde: ultimoLoteFacturacion.periodoDesde,
            periodoHasta: ultimoLoteFacturacion.periodoHasta,
          }
        : null,
    };
  }

  /**
   * Everything `crear()`'s transaction callback used to do, unchanged
   * internally — numbering, Recibo/`SaldoDocumentoOrigen` creation, the
   * manual/automática application branch, asiento posting — now taking an
   * EXTERNALLY-SUPPLIED `session` instead of opening its own. `crear()`
   * below calls this via `this.transaccion(...)` for a single row;
   * `LoteRecibosService.ejecutarAplicacion` calls it directly, sequentially,
   * once per row, inside ONE shared `session.withTransaction(...)` per
   * tanda — this file's own class docblock is unaffected, only this
   * method's call sites multiply.
   *
   * `numeroReservado`, when supplied, skips the internal
   * `numeracion.siguienteDocumento(...)` call and uses it as-is instead —
   * the batch path pre-reserves a whole block of numbers OUTSIDE any
   * transaction (`LoteRecibosService.ejecutarAplicacion`, via
   * `NumeracionService.reservarBloqueDocumentos`) specifically so
   * concurrent tandas never all `$inc` the SAME counter document from
   * inside their own open transactions, which would write-conflict each
   * other. `crear()`'s own single-row call below never passes this — it
   * keeps calling `siguienteDocumento` exactly as before.
   */
  async crearEnSesion(
    session: ClientSession,
    accountId: string,
    dto: CrearReciboDto,
    contexto: ContextoCreacionRecibo,
    numeroReservado?: NumeroAsignado,
  ): Promise<ReciboContract> {
    const { copropiedadId, destinationAccount, diferenciaConfirmada } =
      contexto;

    const numero =
      numeroReservado ??
      (await this.numeracion.siguienteDocumento(
        copropiedadId.toString(),
        dto.codigo,
        session,
      ));

    const [creado] = await this.recibos.create(
      [
        {
          copropiedadId,
          inmuebleId: new Types.ObjectId(dto.inmuebleId),
          terceroId: new Types.ObjectId(dto.terceroId),
          prefijo: numero.prefijo,
          numero: numero.numero,
          numeroCompleto: numero.completo,
          montoRecibido: dto.montoRecibido,
          fechaRecibo: new Date(dto.fechaRecibo),
          medioPago: dto.medioPago,
          cuentaDestino: destinationAccount,
          referencia: dto.referencia ?? null,
          observaciones: dto.observaciones ?? null,
          // Frozen from here on — the document is immutable once issued.
          // `SaldoDocumentoOrigen` (seeded right below) is the live source
          // every application/reversal actually moves from now on.
          montoAplicado: 0,
          montoSinAplicar: dto.montoRecibido,
          estado: 'activo',
          generadoPor: accountId,
        },
      ],
      { session },
    );

    await this.saldoDocumentoOrigen.create(
      [
        {
          copropiedadId,
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
        copropiedadId,
        creado,
        dto.aplicaciones,
        accountId,
        diferenciaConfirmada,
      );
      totalAplicadoAhora = resultado.creadas.reduce(
        (acc, a) => acc + a.montoAplicado,
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
        copropiedadId,
        creado,
        dto.montoRecibido,
        accountId,
      );
      totalAplicadoAhora = resultado.aplicadas.reduce(
        (acc, a) => acc + a.montoAplicado,
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
        camposFrozen.observaciones = generado;
      }
    }
    // Frozen alongside `observaciones` — see `Recibo.montoOtrosIngresos`'s own
    // docblock on why this can't be derived later the way a discount can.
    if (enviarAOtrosIngresos) {
      camposFrozen.montoOtrosIngresos = sobranteReal;
    }
    if (Object.keys(camposFrozen).length > 0) {
      await this.recibos
        .findOneAndUpdate(
          { _id: creado._id, copropiedadId },
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
      .findOne({ _id: creado._id, copropiedadId })
      .session(session)
      .exec();
    await this.postearAsientoRecibo(
      session,
      copropiedadId,
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
        copropiedadId,
        creado._id,
        sobranteReal,
        'activo',
      );
    }

    const final = await this.recibos
      .findOne({ _id: creado._id, copropiedadId })
      .session(session)
      .exec();
    // "Aplicado" is the full amount CREDITED TO CARTERA — cartera-cash
    // plus whatever discount absorbed the rest (see `anular()`'s own
    // `montoAplicadoCarteraTotal`, the established convention this
    // mirrors: `recibo.montoAplicado` alone is cash-only, same trap).
    // `totalAplicadoAhora` already includes any discount, confirmed or
    // automatic — see its own comment above. Otros Ingresos is deliberately
    // NEVER folded in here — it never touched cartera at all, so it's its
    // own field (`montoOtrosIngresos`, read by `toRecibo` straight off
    // `final.montoOtrosIngresos`, just persisted above) instead of being
    // added to "Aplicado", which previously made the two indistinguishable.
    return toRecibo(
      final!,
      totalAplicadoAhora,
      enviarAOtrosIngresos ? 0 : sobranteReal,
      await this.resolverInmuebleCodigo(final!.inmuebleId, copropiedadId),
    );
  }

  /**
   * Turns one tanda's worth of `EscrituraFilaAplicacionLote` (Task 5) into
   * a handful of `insertMany`/`bulkWrite` calls, one per collection —
   * design §4 step 8. Runs inside the SAME session/transaction
   * `LoteRecibosService.procesarTanda` already opens; a thrown error here
   * aborts that transaction exactly like a thrown error inside today's
   * per-row loop does.
   */
  async escribirEscriturasTandaAplicacionLote(
    session: ClientSession,
    copropiedadId: Types.ObjectId,
    escrituras: EscrituraFilaAplicacionLote[],
  ): Promise<void> {
    if (escrituras.length === 0) return;

    await this.recibos.insertMany(
      escrituras.map((e) => e.recibo),
      { session },
    );
    await this.saldoDocumentoOrigen.insertMany(
      escrituras.map((e) => e.saldoDocumentoOrigen),
      { session },
    );
    const aplicacionesCartera = escrituras.flatMap(
      (e) => e.aplicacionesCartera,
    );
    if (aplicacionesCartera.length > 0) {
      await this.aplicaciones.insertMany(aplicacionesCartera, { session });
    }
    await this.asientos.insertMany(
      escrituras.map((e) => e.asientoContable),
      { session },
    );

    // SaldoTotalDocumento — authoritative, guarded, never clamped. One op
    // per distinct document, delta SUMMED across every row in this tanda
    // that touched it: safe, because each row's own consumption was
    // already bounded by `aplicarFifoEnMemoria`'s in-memory tracking, so
    // the tanda's TOTAL consumption per document is exactly as legitimate
    // as N separate guarded decrements would have been.
    const saldoTotalPorDocumento = new Map<string, number>();
    for (const e of escrituras) {
      for (const d of e.saldoTotalDocumentoDeltas) {
        const clave = d.documentoId.toString();
        saldoTotalPorDocumento.set(
          clave,
          (saldoTotalPorDocumento.get(clave) ?? 0) + d.delta,
        );
      }
    }
    if (saldoTotalPorDocumento.size > 0) {
      const operaciones = [...saldoTotalPorDocumento].map(([clave, delta]) => ({
        updateOne: {
          filter: {
            documentoId: new Types.ObjectId(clave),
            $expr: { $gte: ['$saldoPendiente', -delta] },
          },
          update: { $inc: { saldoPendiente: delta } },
        },
      }));
      const resultado = await this.saldoTotalDocumento.bulkWrite(operaciones, {
        session,
      });
      if (resultado.matchedCount !== operaciones.length) {
        throw new ConflictException(
          'Saldo insuficiente al aplicar uno o más documentos de esta tanda',
        );
      }
    }

    // SaldoCartera — reconcilable cache (see its own schema docblock), same
    // clamp-at-zero pipeline `ajustarSaldosCartera` already uses. One op per
    // distinct (inmuebleId, conceptoId), deltas summed the same way as
    // above — a documented, safe equivalence for a cache that is never
    // authoritative (its own schema docblock says so).
    const saldoCarteraPorClave = new Map<
      string,
      { inmuebleId: Types.ObjectId; conceptoId: Types.ObjectId; delta: number }
    >();
    for (const e of escrituras) {
      for (const d of e.saldoCarteraDeltas) {
        const clave = `${d.inmuebleId.toString()}:${d.conceptoId.toString()}`;
        const previo = saldoCarteraPorClave.get(clave);
        saldoCarteraPorClave.set(clave, {
          inmuebleId: d.inmuebleId,
          conceptoId: d.conceptoId,
          delta: (previo?.delta ?? 0) + d.delta,
        });
      }
    }
    if (saldoCarteraPorClave.size > 0) {
      await this.saldos.bulkWrite(
        [...saldoCarteraPorClave.values()].map((d) => ({
          updateOne: {
            filter: {
              copropiedadId,
              inmuebleId: d.inmuebleId,
              conceptoId: d.conceptoId,
            },
            update: [
              {
                $set: {
                  copropiedadId: { $ifNull: ['$copropiedadId', copropiedadId] },
                  inmuebleId: { $ifNull: ['$inmuebleId', d.inmuebleId] },
                  conceptoId: { $ifNull: ['$conceptoId', d.conceptoId] },
                  saldoPendiente: {
                    $max: [
                      0,
                      { $add: [{ $ifNull: ['$saldoPendiente', 0] }, d.delta] },
                    ],
                  },
                },
              },
            ],
            upsert: true,
          },
        })),
        { session },
      );
    }

    // CarteraPorDocumento — same clamp-at-zero pipeline as
    // `ajustarCarteraPorDocumento`, one op per distinct (documentoId,
    // conceptoId).
    const carteraPorDocumentoPorClave = new Map<
      string,
      {
        documentoId: Types.ObjectId;
        conceptoId: Types.ObjectId;
        inmuebleId: Types.ObjectId;
        tipoDocumento: 'FV' | 'ND' | 'SI';
        delta: number;
      }
    >();
    for (const e of escrituras) {
      for (const d of e.carteraPorDocumentoDeltas) {
        const clave = `${d.documentoId.toString()}:${d.conceptoId.toString()}`;
        const previo = carteraPorDocumentoPorClave.get(clave);
        carteraPorDocumentoPorClave.set(clave, {
          ...d,
          delta: (previo?.delta ?? 0) + d.delta,
        });
      }
    }
    if (carteraPorDocumentoPorClave.size > 0) {
      await this.carteraPorDocumento.bulkWrite(
        [...carteraPorDocumentoPorClave.values()].map((d) => ({
          updateOne: {
            filter: { documentoId: d.documentoId, conceptoId: d.conceptoId },
            update: [
              {
                $set: {
                  copropiedadId: { $ifNull: ['$copropiedadId', copropiedadId] },
                  inmuebleId: { $ifNull: ['$inmuebleId', d.inmuebleId] },
                  tipoDocumento: {
                    $ifNull: ['$tipoDocumento', d.tipoDocumento],
                  },
                  documentoId: { $ifNull: ['$documentoId', d.documentoId] },
                  conceptoId: { $ifNull: ['$conceptoId', d.conceptoId] },
                  montoOriginal: { $ifNull: ['$montoOriginal', 0] },
                  saldoAnterior: { $ifNull: ['$saldoAnterior', 0] },
                  saldoNuevo: { $ifNull: ['$saldoNuevo', 0] },
                  saldoPendiente: {
                    $max: [
                      0,
                      { $add: [{ $ifNull: ['$saldoPendiente', 0] }, d.delta] },
                    ],
                  },
                },
              },
            ],
            upsert: true,
          },
        })),
        { session },
      );
    }
  }

  /**
   * Creates a Recibo. With `aplicaciones` present, applies them manually in
   * the same transaction (all-or-nothing, design §6); with
   * `aplicacionAutomatica`, FIFO applies instead. Neither present: the
   * whole `montoRecibido` becomes anticipo. Now a thin wrapper around
   * `prepararCreacion`/`crearEnSesion` — see those methods for the actual
   * logic, extracted so `LoteRecibosService.ejecutarAplicacion` can reuse
   * both across a tanda of rows sharing one transaction.
   *
   * Presentation generation is no longer triggered here — under the
   * pdfmake + frontend-render model, `solicitar-generacion`/
   * `confirmar-generacion` are separate, explicit actions the frontend
   * calls later (`RecibosController`), never something `crear()` does
   * internally.
   */
  async crear(accountId: string, dto: CrearReciboDto): Promise<ReciboContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const contexto = await this.prepararCreacion(dto, copropiedadId);
    return this.transaccion((session) =>
      this.crearEnSesion(session, accountId, dto, contexto),
    );
  }

  /**
   * Voids a Recibo, cascading unconditionally: every `activa`
   * AplicacionRecibo it made is reversed, its Factura's
   * `saldoPendiente` is restored — even one already voided through
   * another path, which is harmless bookkeeping and never "reopens" that
   * document (design §6) — and ONE consolidated reversing journal entry is
   * always posted, using the Recibo's OWN cached totals
   * (`montoAplicado`/`montoSinAplicar`/`montoRecibido`) rather than
   * replaying every prior call's history (Task 2's corrected accounting
   * design). It is unconditional, unlike the old (buggy) version of this
   * method: `montoRecibido` is always > 0 (DTO validation), so there is
   * always something to reverse — at minimum the original cash entry.
   */
  async anular(
    id: string,
    dto: AnularReciboDto,
    accountId: string,
  ): Promise<ReciboContract> {
    const copropiedadId = this.tenant.resolveCoPropertyId();

    // The reversing asiento is dated by the user, never by the server clock
    // — same rule as `crear()`'s own `fechaRecibo` check, same reasoning: an
    // accountant here never works off "today", every document date in the
    // ledger is theirs to declare. A refusal costs no session.
    const ultimoLote = await this.lotes.obtenerUltimoConsolidado(
      copropiedadId.toString(),
    );
    exigirPeriodoFacturacionActual(
      new Date(dto.fecha),
      ultimoLote,
      'La fecha de la anulación',
    );

    return this.transaccion(async (session) => {
      const reciboDoc = await this.recibos
        .findOne({ _id: id, copropiedadId })
        .session(session)
        .exec();
      if (!reciboDoc) {
        throw new NotFoundException(`No se encontró el recibo ${id}`);
      }
      if (reciboDoc.estado === 'anulado') {
        throw new ConflictException(
          `El recibo ${reciboDoc.numeroCompleto} ya está anulado`,
        );
      }
      // `montoAplicado`/`montoSinAplicar` are no longer live fields on the
      // (now immutable) Recibo — merged in fresh from `SaldoDocumentoOrigen`
      // so the reversing entry below (which reads the Recibo's OWN cached
      // totals) sees the REAL current split, not the frozen creation-time
      // values.
      const saldoOrigenPrevio = await this.saldoDocumentoOrigen
        .findOne({ documentoId: reciboDoc._id })
        .session(session)
        .exec();
      const recibo = Object.assign(reciboDoc, {
        montoSinAplicar: saldoOrigenPrevio?.saldoDisponible ?? 0,
        montoAplicado:
          (saldoOrigenPrevio?.montoOriginal ?? 0) -
          (saldoOrigenPrevio?.saldoDisponible ?? 0),
      });

      const aplicacionesActivas = await this.aplicaciones
        .find({
          copropiedadId,
          sourceType: 'RC',
          sourceId: recibo._id,
          estado: 'activa',
        })
        .session(session)
        .exec();

      // Fetched up here (not down with `cuentaCartera`/`cuentaAnticipos`
      // below, where the ORIGINAL code read it) because the desglose loop
      // right below needs `usaCuentasOrden` too, via
      // `cuentaCarteraDeLinea` — same one Mongoose call now serves both.
      const copropiedad = await this.copropiedades
        .findById(copropiedadId)
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
        if (aplicacion.tipoDocumento === 'SI') {
          // Replays the EXACT recorded split (`detalleConceptos`), same as
          // every OTHER reversal here (never re-derives one via a fresh
          // waterfall) — the original application may have been a
          // user-chosen manual distribución, and `ajustarSaldosCartera`'s
          // cascade has no way to reproduce that. No `remanentesPorLinea`/
          // `actualizarRemanentesLinea` — those write to a Factura-only
          // `lines[].remainingAmount` field a Saldo Inicial doesn't have.
          const saldoInicialDoc = await this.saldosIniciales
            ?.findOne({ _id: aplicacion.documentoId, copropiedadId })
            .session(session)
            .exec();
          if (saldoInicialDoc) {
            await restaurarSaldoTotalDocumento(
              this.saldoTotalDocumento,
              session,
              saldoInicialDoc._id,
              aplicacion.montoAplicado,
            );
            const partes = await ajustarSaldosCarteraPorDistribucion(
              this.saldos,
              this.carteraPorDocumento,
              session,
              copropiedadId,
              saldoInicialDoc.inmuebleId,
              aplicacion.detalleConceptos.map((d) => ({
                conceptoId: d.conceptoId,
                monto: d.monto,
              })),
              aplicacion.montoAplicado,
              1,
              { tipoDocumento: 'SI', documentoId: saldoInicialDoc._id },
            );
            for (const parte of partes) {
              const linea = saldoInicialDoc.filas.find((l) =>
                l.conceptoId.equals(parte.conceptoId),
              );
              if (parte.parte !== 0) {
                desglose.push({
                  cuenta: cuentaCarteraDeLinea(
                    linea,
                    copropiedad?.usaCuentasOrden ?? false,
                  ),
                  monto: parte.parte,
                  tipoDocumento: 'SI',
                  numeroDocumento: saldoInicialDoc.numero,
                });
              }
              if (linea?.tipoConcepto === 'intereses') {
                montoAplicadoMora += parte.parte;
              }
            }
          }

          await this.aplicaciones
            .findOneAndUpdate(
              { _id: aplicacion._id, copropiedadId },
              { $set: { estado: 'revertida', revertidoEn: new Date() } },
              { session },
            )
            .exec();

          montoDescuentoTotal += aplicacion.montoDescuento ?? 0;
          continue;
        }

        // `facturaDoc` is null exactly when this aplicación targeted a Nota
        // Débito instead (never a genuinely missing Factura — nothing
        // financial is ever hard-deleted, see the audit law) — the `else`
        // branch below looks that Nota Débito up instead, for its own
        // documento cruce número.
        const facturaDoc = await this.facturas
          .findOne({ _id: aplicacion.documentoId, copropiedadId })
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
            saldoPendiente: saldoPrevio?.saldoPendiente ?? 0,
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
            aplicacion.montoAplicado,
          );
          const partes = await ajustarSaldosCarteraPorDistribucion(
            this.saldos,
            this.carteraPorDocumento,
            session,
            copropiedadId,
            factura.inmuebleId,
            aplicacion.detalleConceptos.map((d) => ({
              conceptoId: d.conceptoId,
              monto: d.monto,
            })),
            aplicacion.montoAplicado,
            1,
            { tipoDocumento: 'FV', documentoId: factura._id },
          );
          await actualizarRemanentesLinea(
            this.facturas,
            session,
            copropiedadId,
            factura._id,
            partes.map((parte) => ({
              conceptoId: parte.conceptoId,
              nuevoValor:
                (remanentesAntes.get(parte.conceptoId.toString()) ?? 0) +
                parte.parte,
            })),
          );
          for (const parte of partes) {
            const linea = factura.lineas.find((l) =>
              l.conceptoId.equals(parte.conceptoId),
            );
            if (parte.parte !== 0) {
              desglose.push({
                cuenta: cuentaCarteraDeLinea(
                  linea,
                  copropiedad?.usaCuentasOrden ?? false,
                ),
                monto: parte.parte,
                tipoDocumento: 'FV',
                numeroDocumento: factura.numero,
              });
            }
            if (linea?.tipoConcepto === 'intereses') {
              montoAplicadoMora += parte.parte;
            }
          }
        } else {
          const notaDebitoDoc = await this.notasDebito
            .findOne({ _id: aplicacion.documentoId, copropiedadId })
            .session(session)
            .exec();
          if (notaDebitoDoc) {
            // Pre-existing bug fixed here: this branch used to only build
            // the accounting `desglose` entry and never actually restored
            // the cartera balance — a Nota Débito paid off by a Recibo that
            // later got voided stayed permanently "fully applied"
            // (`SaldoTotalDocumento.saldoPendiente` never went back up, so
            // it could never be collected again) and `SaldoCartera` stayed
            // permanently understated by that same amount. Mirrors the `FV`
            // branch above and `NotaCreditoService.anular()`'s own `ND`
            // branch: `restaurarSaldoTotalDocumento` first (the atomic
            // "can this be paid again" guard), then
            // `ajustarSaldosCarteraPorDistribucion` replaying the EXACT
            // recorded split (`detalleConceptos`) — never a fresh
            // derivation. No `remanentesPorLinea`/`actualizarRemanentesLinea`
            // — a Nota Débito has a single concepto, no per-línea
            // `remainingAmount` field to keep in sync.
            await restaurarSaldoTotalDocumento(
              this.saldoTotalDocumento,
              session,
              notaDebitoDoc._id,
              aplicacion.montoAplicado,
            );
            const partesNd = await ajustarSaldosCarteraPorDistribucion(
              this.saldos,
              this.carteraPorDocumento,
              session,
              copropiedadId,
              notaDebitoDoc.inmuebleId,
              aplicacion.detalleConceptos.map((d) => ({
                conceptoId: d.conceptoId,
                monto: d.monto,
              })),
              aplicacion.montoAplicado,
              1,
              { tipoDocumento: 'ND', documentoId: notaDebitoDoc._id },
            );
            for (const parte of partesNd) {
              if (parte.parte === 0) continue;
              desglose.push({
                cuenta: null,
                monto: parte.parte,
                tipoDocumento: 'ND',
                numeroDocumento: notaDebitoDoc.numero,
              });
            }
          }
        }

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, copropiedadId },
            { $set: { estado: 'revertida', revertidoEn: new Date() } },
            { session },
          )
          .exec();

        montoDescuentoTotal += aplicacion.montoDescuento ?? 0;
      }

      // ALWAYS posted (no `if (totalRevertido > 0)` gate — that gate was
      // part of the bug this task corrects): uses the Recibo's own cached
      // totals, captured BEFORE the $set below zeroes them, not a sum
      // replayed from the loop above. `copropiedad` was already fetched
      // above, for the desglose loop's own `cuentaCarteraDeLinea` calls.
      const cuentaCartera =
        copropiedad?.cuentaContableCartera ?? CUENTA_SIN_ASIGNAR;
      const cuentaAnticipos =
        copropiedad?.cuentaAnticipos ?? CUENTA_SIN_ASIGNAR;
      const cuentaDescuentos =
        copropiedad?.descuentosCuentaCredito ?? CUENTA_SIN_ASIGNAR;
      const desgloseCartera = desglose.map((d) => ({
        cuenta: d.cuenta ?? cuentaCartera,
        monto: d.monto,
        tipoDocumento: d.tipoDocumento,
        numeroDocumento: d.numeroDocumento,
      }));
      // The cartera side to restore is the FULL amount originally credited
      // (cash plus any discount it absorbed) — `recibo.montoAplicado` alone
      // is cash-only (see `crear()`'s own `cashAplicadoAhora`), so the
      // discount this loop just totaled has to be added back. NOT derived
      // by summing `desgloseCartera`: a factura with no matching `lineas`
      // (already-edge-case territory `ajustarSaldosCartera` guards against)
      // would leave that sum short of what was actually applied, silently
      // understating the reversal — the Recibo's own cached total is the
      // one number that is always right regardless of what `lineas` shows
      // today, months after the original application. `montoOtrosIngresos`
      // is subtracted for the same reason `findOne`/`findAll` subtract it:
      // `recibo.montoAplicado` (from `SaldoDocumentoOrigen`) was decremented
      // for it too, but it never touched cartera at all — see below, where
      // it's reversed on the OTHER side of this entry instead.
      const otherIncomeAmount = recibo.montoOtrosIngresos ?? 0;
      const montoAplicadoCarteraTotal =
        recibo.montoAplicado - otherIncomeAmount + montoDescuentoTotal;
      // A Recibo never has both a real anticipo leftover AND an Otros
      // Ingresos amount (`crear()`'s `destinoSobrante` is a single choice
      // per document) — whichever is nonzero picks which account/description
      // this reversal's second debit line uses. `otherIncomeAmount === 0`
      // (every Recibo before this feature, and every one that chose
      // Anticipos) reproduces the original, untouched behavior exactly.
      const reversaOtrosIngresos = otherIncomeAmount > 0;
      const cuentaAnticiposReversar = reversaOtrosIngresos
        ? (copropiedad?.otrosIngresosCuentaCredito ?? CUENTA_SIN_ASIGNAR)
        : cuentaAnticipos;
      const montoAnticiposReversar = reversaOtrosIngresos
        ? otherIncomeAmount
        : recibo.montoSinAplicar;
      const descripcionAnticiposReversar = reversaOtrosIngresos
        ? 'Reversión de otros ingresos — anulación de recibo de caja'
        : undefined;
      let entries = construirContraAsientoCruce(
        recibo.cuentaDestino,
        cuentaCartera,
        cuentaAnticiposReversar,
        montoAplicadoCarteraTotal,
        montoAnticiposReversar,
        recibo.montoRecibido,
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
        copropiedadId,
        recibo.inmuebleId,
        copropiedad,
        entries,
      );
      await this.asientos.create(
        [
          {
            copropiedadId,
            loteId: null,
            facturaId: null,
            reciboId: recibo._id,
            // The date the user declared for THIS anulación (validated
            // above, before the transaction opened) — never `new Date()`.
            // `fechaAnulacion` below stays the real audit instant on
            // purpose: the business date and the "when it was actually
            // recorded" trail are never the same field.
            fecha: new Date(dto.fecha),
            movimientos: entries,
          },
        ],
        { session },
      );

      // Once voided, a Recibo offers no anticipo and shows no applied
      // amount — every AplicacionRecibo it made is now `revertida`, so
      // montoAplicado is legitimately 0; montoSinAplicar is set to 0 too
      // (not montoRecibido) so a stale `montoSinAplicar > 0` query can
      // never surface a voided receipt as available anticipo without also
      // checking `estado` (design §6 does not specify this; documented
      // here as the deliberate choice).
      await this.recibos
        .findOneAndUpdate(
          { _id: id, copropiedadId },
          {
            $set: {
              estado: 'anulado',
              motivoAnulacion: dto.motivo,
              detalleAnulacion: dto.detalle,
              fechaAnulacion: new Date(),
              // Same $set as the rest of the void so the actor can never be
              // written without the state transition, or the other way round.
              anuladoPor: accountId,
              montoAplicado: 0,
              montoSinAplicar: 0,
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
        .findOne({ _id: id, copropiedadId })
        .session(session)
        .exec();
      return toRecibo(
        final!,
        0,
        0,
        await this.resolverInmuebleCodigo(final!.inmuebleId, copropiedadId),
      );
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
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.estado = query.estado;
    if (query.conAnticipoDisponible) {
      // No longer a field on Recibo itself — resolve candidate ids from
      // `SaldoDocumentoOrigen` first (see that schema's own docblock), same
      // pattern `FacturasService.findAll` already uses on the charge side.
      const conSaldo = await this.saldoDocumentoOrigen
        .find({
          copropiedadId,
          tipoDocumento: 'RC',
          saldoDisponible: { $gt: 0 },
        })
        .exec();
      filtro._id = { $in: conSaldo.map((s) => s.documentoId) };
    }
    if (query.desde || query.hasta) {
      filtro.fechaRecibo = {
        ...(query.desde ? { $gte: new Date(query.desde) } : {}),
        ...(query.hasta ? { $lte: new Date(query.hasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.recibos
        .find(filtro)
        .sort({ numero: -1, _id: -1 })
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
              copropiedadId,
              sourceType: 'RC',
              sourceId: { $in: ids },
              estado: 'activa',
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
        (descuentoPorRecibo.get(clave) ?? 0) + a.montoDescuento,
      );
    }

    // Batched — one query for the whole page, never one per row.
    const inmuebleIds = [
      ...new Set(documentos.map((d) => d.inmuebleId.toString())),
    ].map((idInmueble) => new Types.ObjectId(idInmueble));
    const inmuebles = inmuebleIds.length
      ? await this.inmuebles
          ?.find({ copropiedadId, _id: { $in: inmuebleIds } })
          .exec()
      : [];
    const codigoPorInmueble = new Map(
      (inmuebles ?? []).map((i) => [i._id.toString(), i.codigo]),
    );

    return {
      items: documentos.map((doc) => {
        const idDoc = doc._id.toString();
        const saldo = saldoPorDocumento.get(idDoc);
        const unappliedAmount = saldo?.saldoDisponible ?? 0;
        const appliedAmountCash = saldo
          ? saldo.montoOriginal - saldo.saldoDisponible
          : 0;
        // Subtract `montoOtrosIngresos` for the same reason `findOne` does —
        // `doc` already carries it, no extra query needed.
        const appliedAmount =
          appliedAmountCash -
          (doc.montoOtrosIngresos ?? 0) +
          (descuentoPorRecibo.get(idDoc) ?? 0);
        return toRecibo(
          doc,
          appliedAmount,
          unappliedAmount,
          codigoPorInmueble.get(doc.inmuebleId.toString()) ?? '',
        );
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
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const recibo = await this.recibos
      .findOne({ _id: id, copropiedadId })
      .exec();
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
      .find({ copropiedadId, sourceType: 'RC', sourceId: recibo._id })
      .sort({ aplicadoEn: 1 })
      .exec();
    // Same convention `anular()` already documents on its own
    // `montoAplicadoCarteraTotal`: `montoAplicado` (from `SaldoDocumentoOrigen`)
    // is cash-only — a discount (automatic pronto pago, or a confirmed
    // shortfall) credited MORE to cartera than cash actually moved, so it has
    // to be added back for "Aplicado" to match what each document's own
    // `AplicacionCartera.montoAplicado` row shows. `montoOtrosIngresos` has to
    // be SUBTRACTED for the opposite reason: `SaldoDocumentoOrigen` was
    // decremented for it too (so it stays out of future anticipo
    // reapplication), but it never touched cartera — it's `montoOtrosIngresos`
    // on the contract, not part of "Aplicado" (see `crear()`'s own note).
    const appliedAmount =
      appliedAmountCash -
      (recibo.montoOtrosIngresos ?? 0) +
      aplicaciones
        .filter((a) => a.estado === 'activa')
        .reduce((acc, a) => acc + a.montoDescuento, 0);

    // Batch-resolve each application's target document's own printed
    // number ("FV-1") for display — this row only stores `documentoId`.
    const facturaIds = aplicaciones
      .filter((a) => a.tipoDocumento === 'FV')
      .map((a) => a.documentoId);
    const notaDebitoIds = aplicaciones
      .filter((a) => a.tipoDocumento === 'ND')
      .map((a) => a.documentoId);
    const [facturasDoc, notasDebitoDoc] = await Promise.all([
      facturaIds.length
        ? this.facturas.find({ copropiedadId, _id: { $in: facturaIds } }).exec()
        : [],
      notaDebitoIds.length
        ? this.notasDebito
            .find({ copropiedadId, _id: { $in: notaDebitoIds } })
            .exec()
        : [],
    ]);
    const numerosPorDocumento = new Map<string, string>();
    for (const f of facturasDoc)
      numerosPorDocumento.set(f._id.toString(), f.numeroCompleto);
    for (const nd of notasDebitoDoc) {
      numerosPorDocumento.set(nd._id.toString(), nd.numeroCompleto);
    }

    // `objectPath`/`generatedAt` — resolved from `presentacion_documento` the
    // same way `FacturasService.findOne` resolves its own; `null` for a
    // receipt that never had `solicitar-generacion` called for it yet.
    const presentacion = this.presentacionDocumento
      ? await this.presentacionDocumento.buscar('RC', recibo._id)
      : null;

    return toReciboDetalle(
      recibo,
      appliedAmount,
      unappliedAmount,
      aplicaciones,
      await this.resolverInmuebleCodigo(recibo.inmuebleId, copropiedadId),
      numerosPorDocumento,
      presentacion,
    );
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation.
   */
  async findOneRaw(id: string): Promise<ReciboDocument> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const recibo = await this.recibos
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!recibo) {
      throw new NotFoundException(`No se encontró el recibo ${id}`);
    }
    return recibo;
  }

  /**
   * The pure printable data for this Recibo's own receipt — what
   * `RecibosController`'s `solicitar-generacion` route sends the frontend
   * alongside the template, computed fresh every call (never persisted).
   * Reuses `construirDatosImpresionRecibo` UNCHANGED — it already returned
   * pure data, decoupled from any renderer, so only who consumes the result
   * changed (JSON now, instead of feeding a react-pdf tree).
   */
  async datosImpresion(id: string): Promise<DatosReciboImpresion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const recibo = await this.findOneRaw(id);
    const [aplicacionesActivas, copropiedad] = await Promise.all([
      this.aplicaciones
        .find({
          copropiedadId,
          sourceType: 'RC',
          sourceId: recibo._id,
          estado: 'activa',
        })
        .sort({ aplicadoEn: 1 })
        .exec(),
      this.copropiedades.findById(copropiedadId).exec(),
    ]);
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${copropiedadId.toString()}`,
      );
    }
    // Non-null: always injected in the real app, same convention as every
    // other trailing-optional dependency on this class (see the canonical
    // constructor docblock) — left optional only for the many existing
    // positional-mock tests that never exercise this path.
    const tituloDocumento = await this.tituloDocumento!.resolverGenerico(
      'RC',
      copropiedadId,
    );
    return construirDatosImpresionRecibo(
      recibo,
      aplicacionesActivas,
      copropiedad,
      copropiedadId,
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        inmuebles: this.inmuebles!,
        terceros: this.terceros!,
        cuentasContables: this.cuentasContables!,
      },
      tituloDocumento,
    );
  }

  /**
   * Live-resolves an inmueble's printable código from its id — no frozen
   * field for it exists on `Recibo` itself (unlike `Factura.unitCode`), so
   * every reader looks it up here. Same fallback (`?? ''`) as
   * `CarteraPorConceptosService`'s identical live-resolve.
   *
   * `copropiedadId` is the caller's to resolve, same reasoning as
   * `prepararCreacion` above — every call site already has it in scope
   * from its own earlier `resolveCoPropertyId()` (or, from
   * `crearEnSesion`, from the batch job's own threaded-through value).
   */
  async resolverInmuebleCodigo(
    inmuebleId: Types.ObjectId,
    copropiedadId: Types.ObjectId,
  ): Promise<string> {
    const inmueble = await this.inmuebles
      ?.findOne({ _id: inmuebleId, copropiedadId })
      .exec();
    return inmueble?.codigo ?? '';
  }

  /**
   * Returns active applications for a source document (RC or NC).
   * Used by PDF generation to show application lines.
   */
  async findAplicacionesForSource(
    sourceType: 'RC' | 'NC',
    sourceId: Types.ObjectId,
  ): Promise<AplicacionCarteraDocument[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    return this.aplicaciones
      .find({ copropiedadId, sourceType, sourceId, estado: 'activa' })
      .sort({ aplicadoEn: 1 })
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
    copropiedadId: Types.ObjectId,
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
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .session(session)
      .exec();
    return ejecutarAplicacionManual(
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        saldosIniciales: this.saldosIniciales,
        aplicaciones: this.aplicaciones,
        saldos: this.saldos,
        carteraPorDocumento: this.carteraPorDocumento,
        saldoTotalDocumento: this.saldoTotalDocumento,
        saldoDocumentoOrigen: this.saldoDocumentoOrigen,
        recibos: this.recibos,
        session,
        copropiedadId,
        recibo,
        sourceType: 'RC',
        sourceId: recibo._id,
        sourceDate: recibo.fechaRecibo,
        accountId,
        usaCuentasOrden: copropiedad?.usaCuentasOrden ?? false,
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
    copropiedadId: Types.ObjectId,
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
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .session(session)
      .exec();
    return ejecutarAplicacionFifo(
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        saldosIniciales: this.saldosIniciales,
        aplicaciones: this.aplicaciones,
        saldos: this.saldos,
        carteraPorDocumento: this.carteraPorDocumento,
        saldoTotalDocumento: this.saldoTotalDocumento,
        saldoDocumentoOrigen: this.saldoDocumentoOrigen,
        recibos: this.recibos,
        session,
        copropiedadId,
        recibo,
        sourceType: 'RC',
        sourceId: recibo._id,
        sourceDate: recibo.fechaRecibo,
        accountId,
        usaCuentasOrden: copropiedad?.usaCuentasOrden ?? false,
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
    copropiedadId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    copropiedad: {
      centroCostoDefecto: string | null;
      flujoCajaCodigo: string | null;
    } | null,
    entries: ReturnType<typeof construirAsientoCruce>,
  ): Promise<ReturnType<typeof construirAsientoCruce>> {
    if (!this.cuentasContables) return entries;
    const [cuentas, inmueble] = await Promise.all([
      this.cuentasContables.find({ copropiedadId }).session(session).exec(),
      this.inmuebles
        ?.findOne({ _id: inmuebleId, copropiedadId })
        .session(session)
        .exec(),
    ]);
    const marcas = new Map<string, MarcasCuentaContable>(
      cuentas.map((c) => [
        c.codigo,
        {
          requiereTercero: c.requiereTercero,
          centroUtilidad: c.centroUtilidad,
          centroDestino: c.centroDestino,
          flujoCaja: c.flujoCaja,
          requiereDocumentoCruce: c.requiereDocumentoCruce,
        },
      ]),
    );
    return enriquecerMovimientosConAuxiliares(entries, marcas, {
      terceroCode: inmueble?.codigo ?? null,
      centroCosto: copropiedad?.centroCostoDefecto ?? null,
      flujoCajaCodigo: copropiedad?.flujoCajaCodigo ?? null,
    });
  }

  /**
   * Posts the CREATION-time journal entry: always one debit to
   * `recibo.cuentaDestino` for the full `montoAplicado + montoSinAplicar`
   * (= `montoRecibido`), and one or two credits splitting between
   * `cuentaCartera` (whatever was applied in this same `crear()` call) and
   * `cuentaAnticipos` (whatever remains as anticipo) — see the corrected
   * accounting design on Task 2. Called unconditionally by `crear()`, even
   * when `montoAplicado` is 0 (a pure anticipo still moves real cash).
   */
  private async postearAsientoRecibo(
    session: ClientSession,
    copropiedadId: Types.ObjectId,
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
    // credits `otrosIngresosCuentaCredito` instead of `cuentaAnticipos`, with
    // its own description — `crear()` is what actually stops that money
    // from staying re-appliable (`SaldoDocumentoOrigen`), this method only
    // decides which account the journal entry credits.
    destinoSobrante?: 'anticipo' | 'otros_ingresos',
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .session(session)
      .exec();
    const cuentaCartera =
      copropiedad?.cuentaContableCartera ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos =
      destinoSobrante === 'otros_ingresos'
        ? (copropiedad?.otrosIngresosCuentaCredito ?? CUENTA_SIN_ASIGNAR)
        : (copropiedad?.cuentaAnticipos ?? CUENTA_SIN_ASIGNAR);
    const descripcionAnticipo =
      destinoSobrante === 'otros_ingresos'
        ? 'Otros ingresos — recibo de caja'
        : undefined;
    const cuentaDescuentos =
      copropiedad?.descuentosCuentaDebito ?? CUENTA_SIN_ASIGNAR;
    // `cuenta: null` (no cuentaCartera for that concepto, or a
    // Nota Débito application) resolves to the coproperty's shared
    // cuentaCartera.
    const desgloseCartera = desglose.map((d) => ({
      cuenta: d.cuenta ?? cuentaCartera,
      monto: d.monto,
      tipoDocumento: d.tipoDocumento,
      numeroDocumento: d.numeroDocumento,
    }));
    let entries = construirAsientoCruce(
      recibo.cuentaDestino,
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
      copropiedadId,
      recibo.inmuebleId,
      copropiedad,
      entries,
    );

    await this.asientos.create(
      [
        {
          copropiedadId,
          loteId: null,
          facturaId: null,
          reciboId: recibo._id,
          fecha: recibo.fechaRecibo,
          movimientos: entries,
        },
      ],
      { session },
    );
  }
}
