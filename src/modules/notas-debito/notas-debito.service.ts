import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
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
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../database/schemas/notas-credito/nota-credito.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import {
  construirContraAsientoNotaDebito,
  construirMovimientos,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import { toNotaDebito, toNotaDebitoDetalle } from './notas-debito.mapper';
import type {
  NotaDebito as NotaDebitoContract,
  NotaDebitoDetalle,
  Paginado,
} from '../../contracts';
import type { CrearNotaDebitoDto } from './dto/crear-nota-debito.dto';
import type { AnularNotaDebitoDto } from './dto/anular-nota-debito.dto';
import type { ListarNotaDebitoDto } from './dto/listar-nota-debito.dto';

/**
 * Service for Nota Débito: manual additional charges against a property's
 * cartera. Architecturally a payable document (like Factura), not a credit
 * source (like Recibo/NotaCredito).
 */
@Injectable()
export class NotasDebitoService {
  constructor(
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
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
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
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
   * Creates a Nota Débito — a single-concepto charge against an inmueble's
   * cartera. The outstandingBalance starts equal to total, and the document
   * is immediately payable via Recibo/NotaCredito application.
   */
  async crear(
    accountId: string,
    dto: CrearNotaDebitoDto,
  ): Promise<NotaDebitoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(dto.inmuebleId);
    const conceptoId = new Types.ObjectId(dto.conceptoId);

    // Validate concepto exists and belongs to this coproperty.
    const concepto = await this.conceptos
      .findOne({ _id: conceptoId, coPropertyId })
      .exec();
    if (!concepto) {
      throw new NotFoundException(
        `No se encontró el concepto de cobro ${dto.conceptoId}`,
      );
    }

    return this.transaccion(async (session) => {
      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        'ND',
        session,
      );

      const [creada] = await this.notasDebito.create(
        [
          {
            coPropertyId,
            inmuebleId,
            terceroId: null,
            conceptoId,
            description: dto.descripcion ?? null,
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            issueDate: new Date(dto.fechaCargo),
            total: dto.total,
            outstandingBalance: dto.total,
            status: 'emitida',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      // Post creation journal entry: debit cartera, credit income.
      await this.postearAsientoCreacion(
        session,
        coPropertyId,
        creada,
        concepto.accountingIncomeAccount,
      );

      const final = await this.notasDebito
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaDebito(final!);
    });
  }

  /**
   * Lean listing — always scoped to the active copropiedad, honoring filters.
   * Uses `toNotaDebito`, never `toNotaDebitoDetalle`.
   */
  async findAll(
    query: ListarNotaDebitoDto,
  ): Promise<Paginado<NotaDebitoContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;
    if (query.conSaldoPendiente) filtro.outstandingBalance = { $gt: 0 };
    if (query.fechaDesde || query.fechaHasta) {
      filtro.issueDate = {
        ...(query.fechaDesde ? { $gte: new Date(query.fechaDesde) } : {}),
        ...(query.fechaHasta ? { $lte: new Date(query.fechaHasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.notasDebito
        .find(filtro)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.notasDebito.countDocuments(filtro).exec(),
    ]);

    return { items: documentos.map(toNotaDebito), total, pagina, porPagina };
  }

  /**
   * Full detail — includes the `aplicaciones` array via a separate query
   * against `AplicacionCartera`, assembled through `toNotaDebitoDetalle`.
   */
  async findOne(id: string): Promise<NotaDebitoDetalle> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasDebito
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota débito ${id}`);
    }
    const aplicaciones = await this.aplicaciones
      .find({ coPropertyId, documentType: 'ND', documentId: nota._id })
      .sort({ appliedAt: 1 })
      .exec();
    return toNotaDebitoDetalle(nota, aplicaciones);
  }

  /**
   * Voids a Nota Débito. Unlike Recibos/NotasCrédito's anular() which
   * reverses applications *they made*, a NotaDébito's anular() restores
   * the SOURCE documents (Recibos or NotasCrédito) that applied money
   * against it — the opposite direction.
   *
   * Edge case: if a paying source was independently voided before this
   * NotaDébito is voided, its AplicacionCartera row is already 'revertida'
   * from that earlier void — step 1's filter finds nothing to restore for
   * it. No double-restoration is possible by construction.
   */
  async anular(
    id: string,
    dto: AnularNotaDebitoDto,
    accountId: string,
  ): Promise<NotaDebitoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    return this.transaccion(async (session) => {
      const nota = await this.notasDebito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota débito ${id}`);
      }
      if (nota.status === 'anulada') {
        throw new ConflictException(
          `La nota débito ${nota.fullNumber} ya está anulada`,
        );
      }

      // Step 1: Find all active applications where this ND is the target.
      const aplicacionesActivas = await this.aplicaciones
        .find({
          coPropertyId,
          documentType: 'ND',
          documentId: nota._id,
          status: 'activa',
        })
        .session(session)
        .exec();

      // Step 2: For each, revert the application and restore the source.
      for (const aplicacion of aplicacionesActivas) {
        await this.restaurarMontoFuente(session, coPropertyId, aplicacion);

        await this.aplicaciones
          .findOneAndUpdate(
            { _id: aplicacion._id, coPropertyId },
            { $set: { status: 'revertida', revertedAt: new Date() } },
            { session },
          )
          .exec();
      }

      // Step 3: Post ONE consolidated reversing journal entry.
      const copropiedad = await this.copropiedades
        .findById(coPropertyId)
        .session(session)
        .exec();
      const cuentaCartera =
        copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
      const cuentaIngreso =
        copropiedad?.debitNotesAccount ?? CUENTA_SIN_ASIGNAR;
      const entries = construirContraAsientoNotaDebito(
        cuentaCartera,
        cuentaIngreso,
        nota.total,
      );
      await this.asientos.create(
        [
          {
            coPropertyId,
            loteId: null,
            facturaId: null,
            reciboId: null,
            notaCreditoId: null,
            notaDebitoId: nota._id,
            date: new Date(),
            entries,
          },
        ],
        { session },
      );

      // Step 4: Update the Nota Débito's own status.
      await this.notasDebito
        .findOneAndUpdate(
          { _id: id, coPropertyId },
          {
            $set: {
              status: 'anulada',
              outstandingBalance: 0,
              voidedReason: dto.motivo,
              voidedDetail: dto.detalle,
              voidedAt: new Date(),
              voidedBy: accountId,
            },
          },
          { session },
        )
        .exec();

      const final = await this.notasDebito
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toNotaDebito(final!);
    });
  }

  /**
   * Restores the source document's unappliedAmount when voiding a Nota
   * Débito application. The source is either a Recibo or a Nota Crédito —
   * dispatched by `aplicacion.sourceType`.
   */
  private async restaurarMontoFuente(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    aplicacion: AplicacionCarteraDocument,
  ): Promise<void> {
    if (aplicacion.sourceType === 'RC') {
      await this.recibos
        .findOneAndUpdate(
          { _id: aplicacion.sourceId, coPropertyId },
          {
            $inc: {
              unappliedAmount: aplicacion.amountApplied,
              appliedAmount: -aplicacion.amountApplied,
            },
          },
          { session },
        )
        .exec();
    } else if (aplicacion.sourceType === 'NC') {
      await this.notasCredito
        .findOneAndUpdate(
          { _id: aplicacion.sourceId, coPropertyId },
          {
            $inc: {
              unappliedAmount: aplicacion.amountApplied,
              appliedAmount: -aplicacion.amountApplied,
            },
          },
          { session },
        )
        .exec();
    }
  }

  /**
   * Posts the CREATION-time journal entry: debit `cuentaCartera` for the
   * total, credit `cuentaIngreso` for the total. Reuses `construirMovimientos`
   * with a single-line shape built from the conceptoId.
   */
  private async postearAsientoCreacion(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaDebitoDocument,
    cuentaIngreso: string | null,
  ): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(coPropertyId)
      .session(session)
      .exec();
    const cuentaCartera = copropiedad?.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
    const incomeAccount = cuentaIngreso ?? CUENTA_SIN_ASIGNAR;

    const entries = construirMovimientos(
      {
        total: nota.total,
        lines: [
          { accountingIncomeAccount: incomeAccount, totalAmount: nota.total },
        ],
      },
      cuentaCartera,
    );

    await this.asientos.create(
      [
        {
          coPropertyId,
          loteId: null,
          facturaId: null,
          reciboId: null,
          notaCreditoId: null,
          notaDebitoId: nota._id,
          date: new Date(),
          entries,
        },
      ],
      { session },
    );
  }
}
