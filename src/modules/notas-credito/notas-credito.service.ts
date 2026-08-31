import {
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
  ajustarSaldosCartera,
  decrementarSaldoFactura,
} from '../recibos/cruce.util';
import {
  construirAsientoCruce,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import { validarDistribucionNotaCredito } from './distribucion.util';
import { toNotaCredito } from './notas-credito.mapper';
import type { NotaCredito as NotaCreditoContract } from '../../contracts';
import type { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';

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
        throw new NotFoundException(`No se encontró la factura ${dto.facturaId}`);
      }
      // A voided invoice no longer represents active debt — crediting it
      // has no meaning (design §6).
      if (factura.status !== 'emitida') {
        throw new ConflictException(
          `La factura ${factura.fullNumber} está anulada y no admite una nota crédito`,
        );
      }

      // BadRequestException before ANY write — distribution shape is
      // checked against the anchor invoice's OWN lines, never the database.
      validarDistribucionNotaCredito(
        dto.distribucion.map((l) => ({ conceptoId: l.conceptoId, monto: l.monto })),
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
            inmuebleId: new Types.ObjectId(dto.inmuebleId),
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
      const montoAAplicar = Math.min(dto.montoTotal, factura.outstandingBalance);
      let totalAplicadoAhora = 0;
      if (montoAAplicar > 0) {
        const facturaActualizada = await decrementarSaldoFactura(
          this.facturas,
          session,
          coPropertyId,
          facturaId,
          montoAAplicar,
        );
        await ajustarSaldosCartera(
          this.saldos,
          session,
          coPropertyId,
          facturaActualizada,
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
    const cuentaDevoluciones = copropiedad?.creditNotesAccount ?? CUENTA_SIN_ASIGNAR;
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
