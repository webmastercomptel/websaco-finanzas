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
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { PeriodoService } from '../../common/contabilidad/periodo.service';
import {
  ajustarSaldosCartera,
  ajustarSaldosCarteraPorDistribucion,
  AplicacionInvalidaError,
  decrementarSaldoFactura,
  decrementarSaldoNotaDebito,
} from './cruce.util';
import {
  construirAsientoCruce,
  construirContraAsientoCruce,
  construirMovimientosAplicacionAnticipo,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import {
  toAplicacionCartera,
  toRecibo,
  toReciboDetalle,
} from './recibos.mapper';
import type {
  Recibo as ReciboContract,
  ErrorAplicacion,
  Paginado,
  ReciboDetalle,
  ResultadoAplicacion,
} from '../../contracts';
import type { CrearReciboDto } from './dto/crear-recibo.dto';
import type { AplicacionSolicitadaDto } from './dto/aplicacion-solicitada.dto';
import type { AplicarReciboDto } from './dto/aplicar-recibo.dto';
import type { AnularReciboDto } from './dto/anular-recibo.dto';
import type { ListarRecibosDto } from './dto/listar-recibos.dto';

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
        'RC',
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
      if (dto.aplicaciones?.length) {
        const creadas = await this.aplicarManual(
          session,
          coPropertyId,
          creado,
          dto.aplicaciones,
          accountId,
        );
        totalAplicadoAhora = creadas.reduce(
          (acc, a) => acc + a.amountApplied,
          0,
        );
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
        dto.montoRecibido - totalAplicadoAhora,
      );

      const final = await this.recibos
        .findOne({ _id: creado._id, coPropertyId })
        .session(session)
        .exec();
      return toRecibo(final!);
    });
  }

  /**
   * Applies an existing receipt's `unappliedAmount` against new documents —
   * the deferred-cruce case (design §5). Manual and FIFO share the exact
   * same private helpers `crear()` uses, so the two entry points never
   * drift apart. Posts via `postearAsientoAplicacionAnticipo`, NOT
   * `postearAsientoRecibo` — the cash was already booked at creation time,
   * so this only ever moves the liability into the receivable, never
   * `destinationAccount` again.
   */
  async aplicar(
    id: string,
    dto: AplicarReciboDto,
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
      const recibo = await this.recibos
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!recibo) {
        throw new NotFoundException(`No se encontró el recibo ${id}`);
      }
      if (recibo.status !== 'activo') {
        throw new ConflictException(
          `El recibo ${recibo.fullNumber} está anulado y no admite nuevas aplicaciones`,
        );
      }

      if (dto.aplicaciones?.length) {
        const creadas = await this.aplicarManual(
          session,
          coPropertyId,
          recibo,
          dto.aplicaciones,
          accountId,
        );
        const totalAplicado = creadas.reduce(
          (acc, a) => acc + a.amountApplied,
          0,
        );
        if (totalAplicado > 0) {
          await this.postearAsientoAplicacionAnticipo(
            session,
            coPropertyId,
            recibo,
            totalAplicado,
          );
        }
        const reciboFinal = await this.recibos
          .findOne({ _id: id, coPropertyId })
          .session(session)
          .exec();
        return {
          aplicadas: creadas.map(toAplicacionCartera),
          montoSinAplicar: reciboFinal!.unappliedAmount,
          errores: [],
        };
      }

      const resultado = await this.aplicarFifo(
        session,
        coPropertyId,
        recibo,
        recibo.unappliedAmount,
        accountId,
      );
      const totalAplicado = resultado.aplicadas.reduce(
        (acc, a) => acc + a.amountApplied,
        0,
      );
      if (totalAplicado > 0) {
        await this.postearAsientoAplicacionAnticipo(
          session,
          coPropertyId,
          recibo,
          totalAplicado,
        );
      }
      return {
        aplicadas: resultado.aplicadas.map(toAplicacionCartera),
        montoSinAplicar: resultado.montoSinAplicar,
        errores: resultado.errores,
      };
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
          await ajustarSaldosCartera(
            this.saldos,
            session,
            coPropertyId,
            factura,
            aplicacion.amountApplied,
            1,
          );
        }

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, coPropertyId },
            { $set: { status: 'revertida', revertedAt: new Date() } },
            { session },
          )
          .exec();
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
      const entries = construirContraAsientoCruce(
        recibo.destinationAccount,
        cuentaCartera,
        cuentaAnticipos,
        recibo.appliedAmount,
        recibo.unappliedAmount,
        recibo.receivedAmount,
        'RC',
      );
      await this.asientos.create(
        [
          {
            coPropertyId,
            loteId: null,
            facturaId: null,
            reciboId: recibo._id,
            date: new Date(),
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
        .sort({ receivedDate: -1, _id: -1 })
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
    return toReciboDetalle(recibo, aplicaciones);
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
   * Applies `solicitadas` against their documents — ALL of them, or none:
   * if the sum exceeds `recibo.unappliedAmount`, or any single line's
   * `decrementarSaldoFactura` call throws, the whole transaction aborts
   * (design §6, "manual application mode is all-or-nothing"). Reused by
   * `crear()` (this task) and `aplicar()` (Task 8).
   */
  private async aplicarManual(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    recibo: ReciboDocument,
    solicitadas: AplicacionSolicitadaDto[],
    accountId: string,
  ): Promise<AplicacionCarteraDocument[]> {
    const sumaSolicitada = solicitadas.reduce(
      (acc, a) => acc + a.montoAplicado,
      0,
    );
    if (sumaSolicitada > recibo.unappliedAmount) {
      throw new ConflictException(
        `La suma solicitada (${sumaSolicitada}) supera el saldo sin aplicar ` +
          `del recibo ${recibo.fullNumber} (${recibo.unappliedAmount})`,
      );
    }

    const creadas: AplicacionCarteraDocument[] = [];
    for (const solicitada of solicitadas) {
      const documentoId = new Types.ObjectId(solicitada.documentoId);

      // FIFO filters its candidates by `inmuebleId` when it builds the list;
      // manual mode takes whatever `documentoId` the caller sent, and
      // `decrementarSaldoFactura`/`decrementarSaldoNotaDebito` only guard
      // {_id, coPropertyId, status, saldo} — so without this a receipt
      // issued for one unit could be applied against ANOTHER unit's
      // document inside the same coproperty, corrupting both units'
      // per-unit balance views.
      //
      // Checked after the decrement rather than before, because both
      // decrement functions already return the document — no second read
      // needed — and manual mode is all-or-nothing: throwing here aborts
      // the whole transaction, so the decrement above is rolled back with
      // it.
      if (solicitada.tipoDocumento === 'ND') {
        const notaDebito = await decrementarSaldoNotaDebito(
          this.notasDebito,
          session,
          coPropertyId,
          documentoId,
          solicitada.montoAplicado,
        );

        if (!notaDebito.inmuebleId.equals(recibo.inmuebleId)) {
          throw new ConflictException(
            `La nota débito ${documentoId.toString()} pertenece a otro ` +
              `inmueble (${notaDebito.inmuebleId.toString()}) que el recibo ` +
              `${recibo.fullNumber} (${recibo.inmuebleId.toString()})`,
          );
        }

        await ajustarSaldosCarteraPorDistribucion(
          this.saldos,
          session,
          coPropertyId,
          notaDebito.inmuebleId,
          [{ conceptoId: notaDebito.conceptoId, monto: notaDebito.total }],
          solicitada.montoAplicado,
          -1,
        );

        const [creada] = await this.aplicaciones.create(
          [
            {
              coPropertyId,
              sourceType: 'RC',
              sourceId: recibo._id,
              documentType: 'ND',
              documentId: documentoId,
              amountApplied: solicitada.montoAplicado,
              status: 'activa',
              appliedAt: new Date(),
              appliedBy: accountId,
            },
          ],
          { session },
        );
        creadas.push(creada);
        continue;
      }

      const factura = await decrementarSaldoFactura(
        this.facturas,
        session,
        coPropertyId,
        documentoId,
        solicitada.montoAplicado,
      );

      if (!factura.inmuebleId.equals(recibo.inmuebleId)) {
        throw new ConflictException(
          `La factura ${documentoId.toString()} pertenece a otro inmueble ` +
            `(${factura.inmuebleId.toString()}) que el recibo ` +
            `${recibo.fullNumber} (${recibo.inmuebleId.toString()})`,
        );
      }

      await ajustarSaldosCartera(
        this.saldos,
        session,
        coPropertyId,
        factura,
        solicitada.montoAplicado,
        -1,
      );

      const [creada] = await this.aplicaciones.create(
        [
          {
            coPropertyId,
            sourceType: 'RC',
            sourceId: recibo._id,
            documentType: 'FV',
            documentId: documentoId,
            amountApplied: solicitada.montoAplicado,
            status: 'activa',
            appliedAt: new Date(),
            appliedBy: accountId,
          },
        ],
        { session },
      );
      creadas.push(creada);
    }

    await this.recibos
      .findOneAndUpdate(
        { _id: recibo._id, coPropertyId },
        {
          $inc: {
            appliedAmount: sumaSolicitada,
            unappliedAmount: -sumaSolicitada,
          },
        },
        { session },
      )
      .exec();

    return creadas;
  }

  /**
   * Walks the inmueble's open Facturas AND open Notas Débito, merged into
   * one oldest-first queue, applying until `montoDisponible` is exhausted or
   * there is nothing left open — stopping partway through is the expected
   * outcome (design §6, "FIFO automatic mode is best-effort"), not an error.
   * A document that turns out invalid since the list was built (voided, or
   * someone else just exhausted its balance in this same transaction) is
   * skipped and reported in `errores`, never a hard failure of the whole
   * call.
   *
   * Notas Débito (Notas Débito design §5) carry no `dueDate` of their own —
   * only `issueDate` — so the merge key is each item's own due date when it
   * has one, its issue date otherwise; ties break on `_id`, matching the
   * pre-merge per-collection sort.
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
  }> {
    const [facturasAbiertas, notasDebitoAbiertas] = await Promise.all([
      this.facturas
        .find({
          coPropertyId,
          inmuebleId: recibo.inmuebleId,
          status: 'emitida',
          outstandingBalance: { $gt: 0 },
        })
        .sort({ dueDate: 1, issueDate: 1, _id: 1 })
        .session(session)
        .exec(),
      this.notasDebito
        .find({
          coPropertyId,
          inmuebleId: recibo.inmuebleId,
          status: 'emitida',
          outstandingBalance: { $gt: 0 },
        })
        .sort({ issueDate: 1, _id: 1 })
        .session(session)
        .exec(),
    ]);

    type Candidato =
      | { tipo: 'FV'; doc: FacturaDocument; prioridad: Date }
      | { tipo: 'ND'; doc: NotaDebitoDocument; prioridad: Date };

    const abiertas: Candidato[] = [
      ...facturasAbiertas.map((factura): Candidato => ({
        tipo: 'FV',
        doc: factura,
        prioridad: factura.dueDate ?? factura.issueDate,
      })),
      ...notasDebitoAbiertas.map((nota): Candidato => ({
        tipo: 'ND',
        doc: nota,
        prioridad: nota.issueDate,
      })),
    ].sort((a, b) => {
      const porFecha = a.prioridad.getTime() - b.prioridad.getTime();
      if (porFecha !== 0) return porFecha;
      return a.doc._id.toString().localeCompare(b.doc._id.toString());
    });

    const aplicadas: AplicacionCarteraDocument[] = [];
    const errores: ErrorAplicacion[] = [];
    let restante = montoDisponible;
    let totalAplicado = 0;

    for (const candidato of abiertas) {
      if (restante <= 0) break;
      const monto = Math.min(restante, candidato.doc.outstandingBalance);

      try {
        if (candidato.tipo === 'ND') {
          const notaActualizada = await decrementarSaldoNotaDebito(
            this.notasDebito,
            session,
            coPropertyId,
            candidato.doc._id,
            monto,
          );

          await ajustarSaldosCarteraPorDistribucion(
            this.saldos,
            session,
            coPropertyId,
            notaActualizada.inmuebleId,
            [
              {
                conceptoId: notaActualizada.conceptoId,
                monto: notaActualizada.total,
              },
            ],
            monto,
            -1,
          );

          const [creada] = await this.aplicaciones.create(
            [
              {
                coPropertyId,
                sourceType: 'RC',
                sourceId: recibo._id,
                documentType: 'ND',
                documentId: candidato.doc._id,
                amountApplied: monto,
                status: 'activa',
                appliedAt: new Date(),
                appliedBy: accountId,
              },
            ],
            { session },
          );

          aplicadas.push(creada);
          restante -= monto;
          totalAplicado += monto;
          continue;
        }

        const facturaActualizada = await decrementarSaldoFactura(
          this.facturas,
          session,
          coPropertyId,
          candidato.doc._id,
          monto,
        );
        await ajustarSaldosCartera(
          this.saldos,
          session,
          coPropertyId,
          facturaActualizada,
          monto,
          -1,
        );

        const [creada] = await this.aplicaciones.create(
          [
            {
              coPropertyId,
              sourceType: 'RC',
              sourceId: recibo._id,
              documentType: 'FV',
              documentId: candidato.doc._id,
              amountApplied: monto,
              status: 'activa',
              appliedAt: new Date(),
              appliedBy: accountId,
            },
          ],
          { session },
        );

        aplicadas.push(creada);
        restante -= monto;
        totalAplicado += monto;
      } catch (err) {
        // ONLY `AplicacionInvalidaError` means "this document turned out
        // invalid, skip it and say why" — it is what
        // `decrementarSaldoFactura`/`decrementarSaldoNotaDebito` throws when
        // its floor-at-zero guard refuses, the first statement in the try.
        // Anything else came from `ajustarSaldosCartera`/
        // `ajustarSaldosCarteraPorDistribucion` or `aplicaciones.create`,
        // which run AFTER a decrement already succeeded: swallowing one of
        // those into `errores` would let the transaction COMMIT with the
        // document's balance reduced but no AplicacionCartera audit row and
        // no `appliedAmount` increment — money gone with no trace. A real bug
        // must abort the whole transaction loudly, not be filed as a skipped
        // document.
        if (!(err instanceof AplicacionInvalidaError)) {
          throw err;
        }
        errores.push({
          documentoId: candidato.doc._id.toString(),
          mensaje: err.message,
        });
      }
    }

    if (totalAplicado > 0) {
      await this.recibos
        .findOneAndUpdate(
          { _id: recibo._id, coPropertyId },
          {
            $inc: {
              appliedAmount: totalAplicado,
              unappliedAmount: -totalAplicado,
            },
          },
          { session },
        )
        .exec();
    }

    return { aplicadas, errores, montoSinAplicar: restante };
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
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const entries = construirAsientoCruce(
      recibo.destinationAccount,
      cuentaCartera,
      cuentaAnticipos,
      montoAplicado,
      montoSinAplicar,
      'RC',
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

  /**
   * Posts a LATER application's journal entry: debit `cuentaAnticipos`,
   * credit `cuentaCartera`, both for `montoAplicado` — never touches
   * `destinationAccount` (see the corrected accounting design, Task 2:
   * the cash was already debited there at creation time, by
   * `postearAsientoRecibo`). Only called when `montoAplicado > 0` — a call
   * to `aplicar()` that applied nothing (every FIFO candidate was invalid)
   * posts no entry.
   */
  private async postearAsientoAplicacionAnticipo(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    recibo: ReciboDocument,
    montoAplicado: number,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const entries = construirMovimientosAplicacionAnticipo(
      cuentaAnticipos,
      cuentaCartera,
      montoAplicado,
      'RC',
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: recibo._id,
          date: new Date(),
          entries,
        },
      ],
      { session },
    );
  }
}
