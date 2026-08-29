// src/common/numeracion/numeracion.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
  type TipoDocumento,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ConsecutivoLote,
  ConsecutivoLoteDocument,
} from '../../database/schemas/facturacion/consecutivo-lote.schema';

/** A number handed out, ready to stamp on a document. */
export interface NumeroAsignado {
  prefijo: string;
  numero: number;
  /** How it is printed and searched for: "CONJ-2026-1041". */
  completo: string;
  /** Only set by siguienteFactura — siguienteDocumento's internal documents
   *  (RC/NC/ND/NT) draw from ConsecutivoDocumento, not a tax resolution. */
  resolucionId?: Types.ObjectId;
}

const componer = (prefijo: string, numero: number): NumeroAsignado => ({
  prefijo,
  numero,
  completo: prefijo ? `${prefijo}-${numero}` : String(numero),
});

@Injectable()
export class NumeracionService {
  constructor(
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivos: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(ConsecutivoLote.name)
    private readonly consecutivosLote: Model<ConsecutivoLoteDocument>,
  ) {}

  /**
   * Reserves the next invoice number for a coproperty.
   *
   * The increment happens **inside the database**, in one atomic
   * findOneAndUpdate. That is the whole point of this method: two people saving
   * an invoice at the same instant must not receive the same number, and any
   * approach that reads a value and then writes it back — or counts existing
   * documents and adds one — hands them the same number under load. Duplicate
   * invoice numbers are the kind of error an auditor finds and nobody can undo.
   *
   * The range ceiling is part of the same atomic condition, not a check before
   * it. Checking first would leave a window where the last number is handed out
   * twice.
   *
   * Numbers are consumed, never returned. A document that fails to save leaves
   * a gap, and a gap is the honest outcome: reusing the number would mean two
   * different documents wore it, which is worse than a hole in the sequence.
   */
  async siguienteFactura(coPropertyId: string): Promise<NumeroAsignado> {
    const previa = await this.resoluciones
      .findOneAndUpdate(
        {
          coPropertyId: new Types.ObjectId(coPropertyId),
          status: 'active',
          // Field-to-field comparison needs $expr: the ceiling is another
          // column, not a literal.
          $expr: { $lte: ['$nextNumber', '$rangeTo'] },
        },
        { $inc: { nextNumber: 1 } },
        // The pre-increment document: its nextNumber is the one to use.
        { new: false },
      )
      .exec();

    if (previa)
      return {
        ...componer(previa.prefix, previa.nextNumber),
        resolucionId: previa._id,
      };

    // Nothing matched. Two very different situations, and telling them apart is
    // the difference between "ask an administrator to load the resolution" and
    // "call the accountant, we ran out of numbers".
    const activa = await this.resoluciones
      .findOne({
        coPropertyId: new Types.ObjectId(coPropertyId),
        status: 'active',
      })
      .lean()
      .exec();

    if (!activa) {
      throw new NotFoundException(
        'Esta copropiedad no tiene una resolución de facturación activa. ' +
          'Cargala antes de emitir facturas.',
      );
    }

    throw new ConflictException(
      `Se agotó el rango de la resolución ${activa.resolutionNumber} ` +
        `(hasta ${activa.rangeTo}). Hay que cargar una resolución nueva.`,
    );
  }

  /**
   * Reserves the next number for a document that is not a sales invoice.
   *
   * Same atomicity, without a ceiling: receipts and notes are internal, so
   * there is no external range to stay inside. The counter is created on first
   * use — a building that has never issued a receipt should not need somebody
   * to have prepared a row for it.
   */
  async siguienteDocumento(
    coPropertyId: string,
    tipo: Exclude<TipoDocumento, 'FV'>,
  ): Promise<NumeroAsignado> {
    const actualizado = await this.consecutivos
      .findOneAndUpdate(
        {
          coPropertyId: new Types.ObjectId(coPropertyId),
          documentType: tipo,
        },
        {
          $inc: { nextNumber: 1 },
          $setOnInsert: {
            coPropertyId: new Types.ObjectId(coPropertyId),
            documentType: tipo,
            prefix: tipo,
          },
        },
        // The post-increment document: its nextNumber is the one to use.
        // {new: false} was the bug here — on an upsert it returns null for
        // the very first call (forcing a hardcoded "1" fallback), and on
        // every call after that it returns the PRE-increment value, which
        // the previous call already handed out. Reading the post-image
        // directly, like siguienteLote() already does, needs no fallback
        // and never repeats a number.
        { new: true, upsert: true },
      )
      .exec();

    return componer(actualizado.prefix, actualizado.nextNumber);
  }

  /**
   * Reserves the next batch number for a coproperty's billing cycle.
   *
   * Same atomicity as siguienteDocumento, simpler shape: a Lote carries no
   * prefix and no external range, just a running integer per building.
   */
  async siguienteLote(coPropertyId: string): Promise<number> {
    const actualizado = await this.consecutivosLote
      .findOneAndUpdate(
        { coPropertyId: new Types.ObjectId(coPropertyId) },
        { $inc: { nextNumber: 1 } },
        { new: true, upsert: true },
      )
      .exec();

    return actualizado.nextNumber;
  }
}
