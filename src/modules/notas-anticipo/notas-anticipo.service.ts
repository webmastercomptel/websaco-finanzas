import {
  BadRequestException,
  ConflictException,
  Injectable,
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
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { exigirPeriodoFacturacionActual } from '../../common/contabilidad/periodo-calendario.util';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { LotesFacturacionService } from '../facturacion/lotes.service';
import {
  actualizarRemanentesLinea,
  ajustarSaldosCarteraPorDistribucion,
  ejecutarAplicacionFifo,
  ejecutarAplicacionManual,
  remanentesPorLinea,
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
 */
@Injectable()
export class NotasAnticipoService {
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
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly numeracion: NumeracionService,
    @InjectConnection() private readonly connection: Connection,
    private readonly lotes: LotesFacturacionService,
    @InjectModel(CuentaContable.name)
    private readonly cuentasContables?: Model<CuentaContableDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles?: Model<InmuebleDocument>,
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

    return this.transaccion(async (session) => {
      const recibo = await this.recibos
        .findOne({
          _id: dto.reciboOrigenId,
          coPropertyId,
          status: 'activo',
        })
        .session(session)
        .exec();
      if (!recibo) {
        throw new NotFoundException(
          `No se encontró el recibo ${dto.reciboOrigenId}`,
        );
      }
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
        recibos: this.recibos,
        session,
        coPropertyId,
        recibo,
        sourceType: 'NA' as const,
        sourceId: creada._id,
        accountId,
      };

      const { totalAplicado, creditosPorCuenta, montoAplicadoMora } = dto
        .aplicaciones?.length
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
              creditosPorCuenta: resultado.creditosPorCuenta,
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
              creditosPorCuenta: resultado.creditosPorCuenta,
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
        creditosPorCuenta,
        montoAplicadoMora,
      );

      const final = await this.notasAnticipo
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaAnticipo(final!);
    });
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

    return { items: documentos.map(toNotaAnticipo), total, pagina, porPagina };
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

    return toNotaAnticipoDetalle(nota, aplicaciones, numerosPorDocumento);
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

      const creditosPorCuenta = new Map<string | null, number>();
      const acumular = (cuenta: string | null, monto: number) => {
        if (monto === 0) return;
        creditosPorCuenta.set(
          cuenta,
          (creditosPorCuenta.get(cuenta) ?? 0) + monto,
        );
      };
      let montoAplicadoMora = 0;

      for (const aplicacion of aplicacionesActivas) {
        if (aplicacion.documentType === 'ND') {
          await this.notasDebito
            .findOneAndUpdate(
              { _id: aplicacion.documentId, coPropertyId },
              { $inc: { outstandingBalance: aplicacion.amountApplied } },
              { session },
            )
            .exec();
          acumular(null, aplicacion.amountApplied);
        } else {
          const factura = await this.facturas
            .findOneAndUpdate(
              { _id: aplicacion.documentId, coPropertyId },
              { $inc: { outstandingBalance: aplicacion.amountApplied } },
              { new: true, session },
            )
            .exec();

          if (factura) {
            // Replays the EXACT split this application recorded
            // (`detalleConceptos`) instead of re-deriving one via the
            // default cascade — same reasoning as `RecibosService.anular()`'s
            // own identical change, INCLUDING its own note on why
            // `remanentesPorLinea` needs the pre-reversal aggregate for any
            // línea it still has to legacy-derive.
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
        }

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, coPropertyId },
            { $set: { status: 'revertida', revertedAt: new Date() } },
            { session },
          )
          .exec();
      }

      // Give the money back to the Recibo it was drawn from.
      await this.recibos
        .findOneAndUpdate(
          { _id: nota.reciboOrigenId, coPropertyId },
          {
            $inc: {
              unappliedAmount: nota.appliedAmount,
              appliedAmount: -nota.appliedAmount,
            },
          },
          { session },
        )
        .exec();

      const copropiedad = await this.copropiedades
        .findById(coPropertyId)
        .session(session)
        .exec();
      const cuentaCartera =
        copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaAnticipos =
        copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
      const desgloseCartera = Array.from(creditosPorCuenta.entries()).map(
        ([cuenta, monto]) => ({ account: cuenta ?? cuentaCartera, monto }),
      );
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
    creditosPorCuenta: Map<string | null, number>,
    montoAplicadoMora: number,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaAnticipos = copropiedad?.advancesAccount ?? CUENTA_SIN_ASIGNAR;
    const desgloseCartera = Array.from(creditosPorCuenta.entries()).map(
      ([cuenta, monto]) => ({ account: cuenta ?? cuentaCartera, monto }),
    );
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
