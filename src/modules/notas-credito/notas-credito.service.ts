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
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import {
  AplicacionInvalidaError,
  ajustarSaldosCartera,
  ajustarSaldosCarteraPorDistribucion,
  decrementarSaldoFactura,
} from '../recibos/cruce.util';
import {
  construirAsientoCruce,
  construirContraAsientoCruce,
  construirMovimientosAplicacionAnticipo,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import { validarDistribucionNotaCredito } from './distribucion.util';
import { toNotaCredito, toNotaCreditoDetalle } from './notas-credito.mapper';
import { toAplicacionCartera } from '../recibos/recibos.mapper';
import type {
  NotaCredito as NotaCreditoContract,
  NotaCreditoDetalle,
  Paginado,
  ResultadoAplicacion,
  ErrorAplicacion,
} from '../../contracts';
import type { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';
import type { AplicarNotaCreditoDto } from './dto/aplicar-nota-credito.dto';
import type { AnularNotaCreditoDto } from './dto/anular-nota-credito.dto';
import type { AplicacionSolicitadaDto } from '../recibos/dto/aplicacion-solicitada.dto';
import type { ListarNotasCreditoDto } from './dto/listar-notas-credito.dto';

/**
 * CANONICAL CONSTRUCTOR — pinned in Task 3, unchanged here. NO
 * `PeriodoService` argument — see Task 3's own note on why `crear()` needs
 * no period check (a Nota Crédito is always dated `new Date()`).
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
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly numeracion: NumeracionService,
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
        'NC',
        session,
      );

      const [creada] = await this.notasCredito.create(
        [
          {
            coPropertyId,
            inmuebleId,
            terceroId: factura.terceroId,
            facturaId,
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            reason: dto.motivo,
            totalAmount: dto.montoTotal,
            distribution: dto.distribucion.map((l) => ({
              conceptoId: new Types.ObjectId(l.conceptoId),
              amount: l.monto,
            })),
            appliedAmount: 0,
            unappliedAmount: dto.montoTotal,
            notes: dto.observaciones ?? null,
            status: 'activo',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      // Always exactly one target: the anchor invoice itself — never a
      // manual/FIFO choice like Recibos' crear() (design §5).
      const montoAAplicar = Math.min(
        dto.montoTotal,
        factura.outstandingBalance,
      );
      let totalAplicadoAhora = 0;
      if (montoAAplicar > 0) {
        // The returned Factura isn't needed here (unlike Recibos'
        // `ajustarSaldosCartera` call sites) — `ajustarSaldosCarteraPorDistribucion`
        // below takes `inmuebleId` and `dto.distribucion` directly, not the
        // Factura's own lines.
        await decrementarSaldoFactura(
          this.facturas,
          session,
          coPropertyId,
          facturaId,
          montoAAplicar,
        );
        // Distribution-based, NOT the proportional-by-invoice-line split
        // `ajustarSaldosCartera` uses — this application is against the
        // anchor invoice, whose concepto breakdown the user explicitly chose
        // via `dto.distribucion` (Task 11 / review Finding 3).
        await ajustarSaldosCarteraPorDistribucion(
          this.saldos,
          session,
          coPropertyId,
          inmuebleId,
          dto.distribucion.map((l) => ({
            conceptoId: new Types.ObjectId(l.conceptoId),
            monto: l.monto,
          })),
          montoAAplicar,
          -1,
        );
        await this.aplicaciones.create(
          [
            {
              coPropertyId,
              sourceType: 'NC',
              sourceId: creada._id,
              documentType: 'FV',
              documentId: facturaId,
              amountApplied: montoAAplicar,
              status: 'activa',
              appliedAt: new Date(),
              appliedBy: accountId,
            },
          ],
          { session },
        );
        await this.notasCredito
          .findOneAndUpdate(
            { _id: creada._id, coPropertyId },
            {
              $inc: {
                appliedAmount: montoAAplicar,
                unappliedAmount: -montoAAplicar,
              },
            },
            { session },
          )
          .exec();
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
      );

      const final = await this.notasCredito
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaCredito(final!);
    });
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
      const nota = await this.notasCredito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota crédito ${id}`);
      }
      if (nota.status !== 'activo') {
        throw new ConflictException(
          `La nota crédito ${nota.fullNumber} está anulada y no admite nuevas aplicaciones`,
        );
      }

      if (dto.aplicaciones?.length) {
        const creadas = await this.aplicarManual(
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
          );
        }
        const notaFinal = await this.notasCredito
          .findOne({ _id: id, coPropertyId })
          .session(session)
          .exec();
        return {
          aplicadas: creadas.map(toAplicacionCartera),
          montoSinAplicar: notaFinal!.unappliedAmount,
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
        );
      }
      return {
        aplicadas: resultado.aplicadas.map(toAplicacionCartera),
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
  ): Promise<AplicacionCarteraDocument[]> {
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
    for (const solicitada of solicitadas) {
      const facturaId = new Types.ObjectId(solicitada.documentoId);
      const factura = await decrementarSaldoFactura(
        this.facturas,
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
            sourceType: 'NC',
            sourceId: nota._id,
            documentType: 'FV',
            documentId: facturaId,
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

    await this.notasCredito
      .findOneAndUpdate(
        { _id: nota._id, coPropertyId },
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
  }> {
    const abiertas = await this.facturas
      .find({
        coPropertyId,
        inmuebleId: nota.inmuebleId,
        status: 'emitida',
        outstandingBalance: { $gt: 0 },
      })
      .sort({ dueDate: 1, issueDate: 1, _id: 1 })
      .session(session)
      .exec();

    const aplicadas: AplicacionCarteraDocument[] = [];
    const errores: ErrorAplicacion[] = [];
    let restante = montoDisponible;
    let totalAplicado = 0;

    for (const factura of abiertas) {
      if (restante <= 0) break;
      const monto = Math.min(restante, factura.outstandingBalance);

      try {
        const facturaActualizada = await decrementarSaldoFactura(
          this.facturas,
          session,
          coPropertyId,
          factura._id,
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
              sourceType: 'NC',
              sourceId: nota._id,
              documentType: 'FV',
              documentId: factura._id,
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
      await this.notasCredito
        .findOneAndUpdate(
          { _id: nota._id, coPropertyId },
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

    return this.transaccion(async (session) => {
      const nota = await this.notasCredito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota crédito ${id}`);
      }
      if (nota.status === 'anulado') {
        throw new ConflictException(
          `La nota crédito ${nota.fullNumber} ya está anulada`,
        );
      }

      const aplicacionesActivas = await this.aplicaciones
        .find({
          coPropertyId,
          sourceType: 'NC',
          sourceId: nota._id,
          status: 'activa',
        })
        .session(session)
        .exec();

      for (const aplicacion of aplicacionesActivas) {
        const factura = await this.facturas
          .findOneAndUpdate(
            { _id: aplicacion.documentId, coPropertyId },
            { $inc: { outstandingBalance: aplicacion.amountApplied } },
            { new: true, session },
          )
          .exec();

        if (factura) {
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
              session,
              coPropertyId,
              nota.inmuebleId,
              nota.distribution.map((l) => ({
                conceptoId: l.conceptoId,
                monto: l.amount,
              })),
              aplicacion.amountApplied,
              1,
            );
          } else {
            await ajustarSaldosCartera(
              this.saldos,
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
            { $set: { status: 'revertida' } },
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
      const entries = construirContraAsientoCruce(
        cuentaDevoluciones,
        cuentaCartera,
        cuentaAnticipos,
        nota.appliedAmount,
        nota.unappliedAmount,
        nota.totalAmount,
        'NC',
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

      const final = await this.notasCredito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toNotaCredito(final!);
    });
  }

  /**
   * Lean listing (design §5, `GET /notas-credito`) — always scoped to the
   * active copropiedad, honoring `ListarNotasCreditoDto`'s filters
   * (`inmuebleId`, `estado`, date range on `createdAt`). Uses `toNotaCredito`,
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
    if (query.desde || query.hasta) {
      filtro.createdAt = {
        ...(query.desde ? { $gte: new Date(query.desde) } : {}),
        ...(query.hasta ? { $lte: new Date(query.hasta) } : {}),
      };
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

    return { items: documentos.map(toNotaCredito), total, pagina, porPagina };
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
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, sourceType: 'NC', sourceId: nota._id })
      .sort({ appliedAt: 1 })
      .exec();
    return toNotaCreditoDetalle(nota, aplicaciones);
  }

  /** Posts a LATER application's journal entry: debit `cuentaAnticipos`,
   *  credit `cuentaCartera`, both for `montoAplicado` — never touches
   *  `cuentaDevoluciones` again (the correction was already booked at
   *  creation time). Only called when `montoAplicado > 0`. */
  private async postearAsientoAplicacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaCreditoDocument,
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
      'NC',
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
   * the full `montoTotal`, credit `cuentaCartera` for whatever applied
   * against the anchor invoice in this call, credit `cuentaAnticipos` for
   * whatever remains unapplied (design §7). Shares `construirAsientoCruce`
   * with Recibos — only `origen: 'NC'` differs.
   */
  private async postearAsientoCreacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaCreditoDocument,
    montoAplicado: number,
    montoSinAplicar: number,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaDevoluciones =
      copropiedad?.creditNotesAccount ?? CUENTA_SIN_ASIGNAR;
    const entries = construirAsientoCruce(
      cuentaDevoluciones,
      cuentaCartera,
      cuentaAnticipos,
      montoAplicado,
      montoSinAplicar,
      'NC',
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
}
