import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  NotaContable,
  NotaContableDocument,
} from '../../database/schemas/notas-contables/nota-contable.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  AsientoContable,
  AsientoContableDocument,
} from '../../database/schemas/facturacion/asiento-contable.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import { ajustarSaldosCarteraPorDistribucion } from '../recibos/cruce.util';
import {
  construirMovimientosReclasificacion,
  CUENTA_SIN_ASIGNAR,
} from '../facturacion/asiento.builder';
import { toNotaContable } from './notas-contables.mapper';
import type {
  NotaContable as NotaContableContract,
  Paginado,
} from '../../contracts';
import type { CrearNotaContableDto } from './dto/crear-nota-contable.dto';
import type { AnularNotaContableDto } from './dto/anular-nota-contable.dto';
import type { ListarNotaContableDto } from './dto/listar-nota-contable.dto';

/**
 * Service for Notas Contables: reclassifying an amount between two
 * ConceptoCobro balances within one inmueble's cartera.
 */
@Injectable()
export class NotasContablesService {
  constructor(
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldos: Model<SaldoCarteraDocument>,
    @InjectModel(AsientoContable.name)
    private readonly asientos: Model<AsientoContableDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptos: Model<ConceptoCobroDocument>,
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
   * Creates a Nota Contable — reclassifies `monto` from one concepto's
   * SaldoCartera to another's, within the same inmueble.
   *
   * Validates: monto > 0, conceptoOrigenId !== conceptoDestinoId, and the
   * origin concepto's current balance >= monto (design §4).
   */
  async crear(
    accountId: string,
    dto: CrearNotaContableDto,
  ): Promise<NotaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(dto.inmuebleId);
    const conceptoOrigenId = new Types.ObjectId(dto.conceptoOrigenId);
    const conceptoDestinoId = new Types.ObjectId(dto.conceptoDestinoId);

    if (conceptoOrigenId.equals(conceptoDestinoId)) {
      throw new ConflictException(
        'El concepto de origen y destino deben ser distintos',
      );
    }

    // `@IsPositive()` on `CrearNotaContableDto` already rejects this at the
    // HTTP boundary (this repo's global `ValidationPipe`, `app-setup.ts`) —
    // but this docblock has always claimed the SERVICE validates `monto > 0`,
    // and every sibling service (RecibosService.aplicarManual, etc.) owns
    // its own business invariants instead of relying solely on the DTO pipe.
    // Without this, `monto <= 0` sails straight through the balance check
    // below (`0 > balanceDisponible` and `-N > balanceDisponible` are both
    // false for any non-negative balance) and reaches
    // `ajustarSaldosCarteraPorDistribucion` with a sign-flipping amount.
    if (dto.monto <= 0) {
      throw new ConflictException('El monto debe ser mayor que cero');
    }

    return this.transaccion(async (session) => {
      // Read origin concepto's current balance — the ONLY authoritative
      // signal for a reclassification (design §4).
      const saldoOrigen = await this.saldos
        .findOne({
          coPropertyId,
          inmuebleId,
          conceptoId: conceptoOrigenId,
        })
        .session(session)
        .exec();

      const balanceDisponible = saldoOrigen?.balance ?? 0;
      if (dto.monto > balanceDisponible) {
        throw new ConflictException(
          `El monto solicitado (${dto.monto}) supera el saldo disponible ` +
            `del concepto de origen (${balanceDisponible})`,
        );
      }

      const numero = await this.numeracion.siguienteDocumento(
        coPropertyId.toString(),
        'NT',
        session,
      );

      const [creada] = await this.notasContables.create(
        [
          {
            coPropertyId,
            inmuebleId,
            conceptoOrigenId,
            conceptoDestinoId,
            monto: dto.monto,
            description: dto.descripcion,
            prefix: numero.prefijo,
            number: numero.numero,
            fullNumber: numero.completo,
            status: 'activo',
            generatedBy: accountId,
          },
        ],
        { session },
      );

      // Decrease origin concepto's balance.
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        session,
        coPropertyId,
        inmuebleId,
        [{ conceptoId: conceptoOrigenId, monto: dto.monto }],
        dto.monto,
        -1,
      );

      // Increase destination concepto's balance.
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        session,
        coPropertyId,
        inmuebleId,
        [{ conceptoId: conceptoDestinoId, monto: dto.monto }],
        dto.monto,
        +1,
      );

      // Post 2-leg accounting entry.
      await this.postearAsiento(
        session,
        coPropertyId,
        creada,
        conceptoOrigenId,
        conceptoDestinoId,
      );

      const final = await this.notasContables
        .findOne({ _id: creada._id, coPropertyId })
        .session(session)
        .exec();
      return toNotaContable(final!);
    });
  }

  /**
   * Lean listing — always scoped to the active copropiedad, honoring filters.
   * Uses `toNotaContable`, no detail-vs-listing split needed (no
   * `aplicaciones` array).
   */
  async findAll(
    query: ListarNotaContableDto,
  ): Promise<Paginado<NotaContableContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.estado) filtro.status = query.estado;
    if (query.fechaDesde || query.fechaHasta) {
      filtro.createdAt = {
        ...(query.fechaDesde ? { $gte: new Date(query.fechaDesde) } : {}),
        ...(query.fechaHasta ? { $lte: new Date(query.fechaHasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.notasContables
        .find(filtro)
        .sort({ createdAt: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.notasContables.countDocuments(filtro).exec(),
    ]);

    return {
      items: documentos.map(toNotaContable),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Full detail — same shape as listing (no `aplicaciones` array to embed,
   * unlike every prior module).
   */
  async findOne(id: string): Promise<NotaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasContables
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota contable ${id}`);
    }
    return toNotaContable(nota);
  }

  /**
   * Returns the raw Mongoose document — used by PDF generation.
   */
  async findOneRaw(id: string): Promise<NotaContableDocument> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const nota = await this.notasContables
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!nota) {
      throw new NotFoundException(`No se encontró la nota contable ${id}`);
    }
    return nota;
  }

  /**
   * Voids a Nota Contable — reverses the reclassification (destino→origen)
   * and posts the mirrored accounting entry (accounts swapped).
   */
  async anular(
    id: string,
    dto: AnularNotaContableDto,
    accountId: string,
  ): Promise<NotaContableContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    return this.transaccion(async (session) => {
      const nota = await this.notasContables
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      if (!nota) {
        throw new NotFoundException(`No se encontró la nota contable ${id}`);
      }
      if (nota.status === 'anulado') {
        throw new ConflictException(
          `La nota contable ${nota.fullNumber} ya está anulada`,
        );
      }

      // Reverse: increase origin, decrease destination (signs swapped).
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        session,
        coPropertyId,
        nota.inmuebleId,
        [{ conceptoId: nota.conceptoOrigenId, monto: nota.monto }],
        nota.monto,
        +1,
      );
      await ajustarSaldosCarteraPorDistribucion(
        this.saldos,
        session,
        coPropertyId,
        nota.inmuebleId,
        [{ conceptoId: nota.conceptoDestinoId, monto: nota.monto }],
        nota.monto,
        -1,
      );

      // Post mirrored entry: swap accounts (design §7).
      await this.postearAsiento(
        session,
        coPropertyId,
        nota,
        nota.conceptoDestinoId,
        nota.conceptoOrigenId,
      );

      await this.notasContables
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

      const final = await this.notasContables
        .findOne({ _id: id, coPropertyId })
        .session(session)
        .exec();
      return toNotaContable(final!);
    });
  }

  /**
   * Posts the 2-leg accounting entry for a reclassification. Reads each
   * concepto's `accountingIncomeAccount` and falls back to
   * `CUENTA_SIN_ASIGNAR` when unset.
   *
   * Called at creation with (origen, destino) and at void with (destino,
   * origen) — the same function, accounts swapped (design §7).
   */
  private async postearAsiento(
    session: ClientSession,
    coPropertyId: Types.ObjectId,
    nota: NotaContableDocument,
    cuentaOrigenConceptoId: Types.ObjectId,
    cuentaDestinoConceptoId: Types.ObjectId,
  ): Promise<void> {
    const [cuentaOrigenDoc, cuentaDestinoDoc] = await Promise.all([
      this.conceptos.findById(cuentaOrigenConceptoId).session(session).exec(),
      this.conceptos.findById(cuentaDestinoConceptoId).session(session).exec(),
    ]);

    const cuentaOrigen =
      cuentaOrigenDoc?.accountingIncomeAccount ?? CUENTA_SIN_ASIGNAR;
    const cuentaDestino =
      cuentaDestinoDoc?.accountingIncomeAccount ?? CUENTA_SIN_ASIGNAR;

    const entries = construirMovimientosReclasificacion(
      cuentaOrigen,
      cuentaDestino,
      nota.monto,
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
          notaContableId: nota._id,
          date: new Date(),
          entries,
        },
      ],
      { session },
    );
  }
}
