import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  AplicacionRecibo,
  AplicacionReciboDocument,
} from '../../database/schemas/recibos/aplicacion-recibo.schema';
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
import { ajustarSaldosCartera, decrementarSaldoFactura } from './cruce.util';
import {
  construirAsientoRecibo,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import { toRecibo } from './recibos.mapper';
import type {
  Recibo as ReciboContract,
  ErrorAplicacion,
} from '../../contracts';
import type { CrearReciboDto } from './dto/crear-recibo.dto';
import type { AplicacionSolicitadaDto } from './dto/aplicacion-solicitada.dto';

/**
 * CANONICAL CONSTRUCTOR — pinned here and never changed by a later task in
 * this plan (same discipline `LotesFacturacionService` documents on its own
 * constructor). `asientos` and `copropiedades` are used on EVERY `crear()`
 * call, unconditionally — not only when `aplicaciones`/`aplicacionAutomatica`
 * is present — because the full `receivedAmount` must always be booked
 * (debited to `destinationAccount`) the moment a Recibo is created, whether
 * or not any of it has been applied yet (design decision, Task 2); `numeracion`
 * and `connection` are what make RC numbering and every balance write live
 * inside one Mongo transaction (design §6). Every test in Tasks 6–10
 * constructs this class with all nine arguments, in this exact order.
 */
@Injectable()
export class RecibosService {
  constructor(
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(AplicacionRecibo.name)
    private readonly aplicaciones: Model<AplicacionReciboDocument>,
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
            destinationAccount: dto.cuentaDestino,
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
  ): Promise<AplicacionReciboDocument[]> {
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

    const creadas: AplicacionReciboDocument[] = [];
    for (const solicitada of solicitadas) {
      const facturaId = new Types.ObjectId(solicitada.documentoId);
      const factura = await decrementarSaldoFactura(
        this.facturas,
        session,
        coPropertyId,
        facturaId,
        solicitada.montoAplicado,
      );
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
            reciboId: recibo._id,
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
   * Walks the inmueble's open Facturas oldest-due-date-first, applying
   * until `montoDisponible` is exhausted or there is nothing left open —
   * stopping partway through is the expected outcome (design §6, "FIFO
   * automatic mode is best-effort"), not an error. A document that turns
   * out invalid since the list was built (voided, or someone else just
   * exhausted its balance in this same transaction) is skipped and
   * reported in `errores`, never a hard failure of the whole call.
   */
  private async aplicarFifo(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    recibo: ReciboDocument,
    montoDisponible: number,
    accountId: string,
  ): Promise<{
    aplicadas: AplicacionReciboDocument[];
    errores: ErrorAplicacion[];
    montoSinAplicar: number;
  }> {
    const abiertas = await this.facturas
      .find({
        coPropertyId,
        inmuebleId: recibo.inmuebleId,
        status: 'emitida',
        outstandingBalance: { $gt: 0 },
      })
      .sort({ dueDate: 1, issueDate: 1, _id: 1 })
      .session(session)
      .exec();

    const aplicadas: AplicacionReciboDocument[] = [];
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
              reciboId: recibo._id,
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
        errores.push({
          documentoId: factura._id.toString(),
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
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
    const entries = construirAsientoRecibo(
      recibo.destinationAccount,
      cuentaCartera,
      cuentaAnticipos,
      montoAplicado,
      montoSinAplicar,
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
