// src/modules/configuracion/documentos/documentos.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
  type TipoDocumento,
} from '../../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../../database/schemas/recibos/recibo.schema';
import {
  NotaCredito,
  NotaCreditoDocument,
} from '../../../database/schemas/notas-credito/nota-credito.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../../database/schemas/notas-debito/nota-debito.schema';
import {
  NotaContable,
  NotaContableDocument,
} from '../../../database/schemas/notas-contables/nota-contable.schema';
import type { DocumentoAdmin, ResolucionAdmin } from '../../../contracts';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../../common/utils/query.utils';
import { toDocumentoAdmin, toResolucionAdmin } from './documentos.mapper';
import type { ActualizarConsecutivoDto } from './dto/actualizar-consecutivo.dto';
import type { CrearResolucionDto } from './dto/crear-resolucion.dto';
import type { ActualizarResolucionMetadataDto } from './dto/actualizar-resolucion-metadata.dto';

@Injectable()
export class DocumentosService {
  constructor(
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivos: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(NotaCredito.name)
    private readonly notasCredito: Model<NotaCreditoDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(NotaContable.name)
    private readonly notasContables: Model<NotaContableDocument>,
    private readonly tenant: TenantContextService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Lists all document numbering rows — both ConsecutivoDocumento and
   * ResolucionFacturacion, for the unified table (spec §5).
   */
  async findAll(): Promise<{
    items: DocumentoAdmin[];
    resolucion: ResolucionAdmin | null;
  }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const [consecutivos, resolucionActiva] = await Promise.all([
      this.consecutivos.find({ coPropertyId }).sort({ documentType: 1 }).exec(),
      this.resoluciones.findOne({ coPropertyId, status: 'active' }).exec(),
    ]);

    return {
      items: consecutivos.map(toDocumentoAdmin),
      resolucion: resolucionActiva ? toResolucionAdmin(resolucionActiva) : null,
    };
  }

  /**
   * Updates a ConsecutivoDocumento row. The nextNumber guardrail (spec §5):
   * reject if the new value would be at or below an already-issued number
   * under the SAME prefix.
   */
  async updateConsecutivo(
    documentType: TipoDocumento,
    dto: ActualizarConsecutivoDto,
  ): Promise<DocumentoAdmin> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const current = await this.consecutivos
      .findOne({ coPropertyId, documentType })
      .exec();

    if (!current) {
      throw new NotFoundException(
        `No se encontró consecutivo para ${documentType}`,
      );
    }

    const newPrefix = dto.prefijo ?? current.prefix;
    const newNextNumber = dto.numeroSiguiente ?? current.nextNumber;

    if (newPrefix === current.prefix && newNextNumber < current.nextNumber) {
      // `current` only ever exists for RC/NC/ND/NT — ConsecutivoDocumento
      // never carries an FV row (see NumeracionService.siguienteDocumento's
      // own `Exclude<TipoDocumento, 'FV'>` signature), so this narrowing is
      // safe: reaching this line already proves documentType isn't 'FV'.
      const maxIssued = await this.getHighestIssuedNumber(
        documentType as Exclude<TipoDocumento, 'FV'>,
        coPropertyId,
        current.prefix,
      );

      if (newNextNumber <= maxIssued) {
        throw new ConflictException(
          `El número ${newNextNumber} ya fue emitido bajo el prefijo ${current.prefix}. ` +
            `El mínimo permitido es ${maxIssued + 1}.`,
        );
      }
    }

    const update: Record<string, unknown> = {};
    if (dto.prefijo !== undefined) update.prefix = dto.prefijo;
    if (dto.numeroSiguiente !== undefined)
      update.nextNumber = dto.numeroSiguiente;
    if (dto.nombreDocumento !== undefined)
      update.displayName = dto.nombreDocumento;
    if (dto.comprobanteContable !== undefined)
      update.accountingVoucherCode = dto.comprobanteContable;
    if (dto.numeroElectronico !== undefined)
      update.electronicNumber = dto.numeroElectronico;

    const updated = await this.consecutivos
      .findOneAndUpdate({ _id: current._id }, { $set: update }, { new: true })
      .exec();

    return toDocumentoAdmin(updated!);
  }

  /**
   * Creates a new ResolucionFacturacion and deactivates the previous one
   * atomically (spec §5).
   *
   * Order matters, and so does the transaction: `ResolucionFacturacionSchema`
   * has a unique partial index on `{coPropertyId, status: 'active'}`
   * (one active resolution per coproperty, ever). Creating the new row
   * BEFORE deactivating the old one — the bug an earlier draft of this
   * method had — throws a duplicate-key error on every coproperty that
   * already has an active resolution, i.e. every call except the very
   * first. Deactivating first and creating second closes that gap, and
   * wrapping both writes in one Mongo transaction (same
   * `connection.startSession()` + `session.withTransaction()` shape
   * `RecibosService.transaccion()` already establishes) is what prevents a
   * failure between the two writes from leaving a coproperty with zero
   * active resolutions.
   */
  async crearResolucion(dto: CrearResolucionDto): Promise<ResolucionAdmin> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (dto.rangoHasta <= dto.rangoDesde) {
      throw new BadRequestException(
        'El rango hasta debe ser mayor que el rango desde.',
      );
    }

    const session = await this.connection.startSession();
    try {
      let creada!: ResolucionFacturacionDocument;
      await session.withTransaction(async () => {
        const anterior = await this.resoluciones
          .findOne({ coPropertyId, status: 'active' })
          .session(session)
          .exec();

        if (anterior) {
          await this.resoluciones
            .updateOne({ _id: anterior._id }, { $set: { status: 'inactive' } })
            .session(session)
            .exec();
        }

        const [nueva] = await this.resoluciones.create(
          [
            {
              coPropertyId,
              resolutionNumber: dto.numeroResolucion,
              prefix: dto.prefijo,
              rangeFrom: dto.rangoDesde,
              rangeTo: dto.rangoHasta,
              nextNumber: dto.rangoDesde,
              validFrom: new Date(dto.vigenciaDesde),
              validUntil: dto.vigenciaHasta
                ? new Date(dto.vigenciaHasta)
                : null,
              status: 'active',
              displayName: dto.nombreDocumento ?? null,
              accountingVoucherCode: dto.comprobanteContable ?? null,
              electronicNumber: dto.numeroElectronico ?? null,
            },
          ],
          { session },
        );
        creada = nueva;
      });
      return toResolucionAdmin(creada);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Metadata-only patch on the active resolution. Never touches
   * prefix/rangeFrom/rangeTo/nextNumber/status.
   */
  async actualizarResolucionMetadata(
    dto: ActualizarResolucionMetadataDto,
  ): Promise<ResolucionAdmin> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const activa = await this.resoluciones
      .findOne({ coPropertyId, status: 'active' })
      .exec();

    if (!activa) {
      throw new NotFoundException(
        'No hay resolución activa para esta copropiedad.',
      );
    }

    const update: Record<string, unknown> = {};
    if (dto.nombreDocumento !== undefined)
      update.displayName = dto.nombreDocumento;
    if (dto.comprobanteContable !== undefined)
      update.accountingVoucherCode = dto.comprobanteContable;
    if (dto.numeroElectronico !== undefined)
      update.electronicNumber = dto.numeroElectronico;

    const updated = await this.resoluciones
      .findByIdAndUpdate(activa._id, { $set: update }, { new: true })
      .exec();

    return toResolucionAdmin(updated!);
  }

  /**
   * Finds the highest numeric suffix already issued under a given prefix —
   * the load-bearing check behind the nextNumber guardrail (spec §5, §8):
   * `updateConsecutivo` must never let an administrator move the counter
   * back below a number some real document already carries.
   *
   * Plain `find()` + in-memory max, never `.aggregate()` — house convention
   * (see AGENTS.md and every other cross-collection computation in this
   * backend). `fullNumber` is the real persisted field
   * (`NumeracionService`'s `componer()`: `"${prefix}-${numero}"`, or bare
   * `numero` when the prefix is empty) — there is no separate `prefijo`/
   * `numeroCompleto` field on any of these documents; those are Spanish
   * contract-layer names that only exist after mapping, never in the
   * database.
   */
  private async getHighestIssuedNumber(
    documentType: Exclude<TipoDocumento, 'FV'>,
    coPropertyId: unknown,
    prefix: string,
  ): Promise<number> {
    const modelMap: Record<
      Exclude<TipoDocumento, 'FV'>,
      Model<{ fullNumber: string }>
    > = {
      RC: this.recibos,
      NC: this.notasCredito,
      ND: this.notasDebito,
      NT: this.notasContables,
    };
    const model = modelMap[documentType];

    const matchPrefix = prefix ? `${prefix}-` : '';
    const docs = await model
      .find(
        {
          coPropertyId,
          fullNumber: { $regex: `^${escapeRegex(matchPrefix)}` },
        },
        { fullNumber: 1 },
      )
      .lean()
      .exec();

    let max = 0;
    for (const doc of docs) {
      const suffix = doc.fullNumber.slice(matchPrefix.length);
      const numero = Number.parseInt(suffix, 10);
      if (Number.isFinite(numero) && numero > max) max = numero;
    }
    return max;
  }
}
