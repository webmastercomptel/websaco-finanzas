// src/common/numeracion/numeracion.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type ClientSession } from 'mongoose';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
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
   *  draw from ConsecutivoDocumento, not a tax resolution. */
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
   *
   * DIAN's electronic-invoicing filing (a ResolucionFacturacion) is not
   * mandatory for every client. When a coproperty has no active one at all —
   * never loaded one, as opposed to having exhausted its range — this falls
   * back to the simple FV consecutivo instead of blocking invoicing outright.
   * `resolucionId` is absent on that path (see NumeroAsignado), and the
   * created Factura's own `resolucionId` stays null.
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
        { returnDocument: 'before' },
      )
      .exec();

    if (previa)
      return {
        ...componer(previa.prefix, previa.nextNumber),
        resolucionId: previa._id,
      };

    // Nothing matched. Two very different situations, and telling them apart is
    // the difference between "fall back to the simple consecutivo" and
    // "call the accountant, we ran out of numbers".
    const activa = await this.resoluciones
      .findOne({
        coPropertyId: new Types.ObjectId(coPropertyId),
        status: 'active',
      })
      .lean()
      .exec();

    if (activa) {
      throw new ConflictException(
        `Se agotó el rango de la resolución ${activa.resolutionNumber} ` +
          `(hasta ${activa.rangeTo}). Hay que cargar una resolución nueva.`,
      );
    }

    // No resolución at all — not every client files DIAN electronic
    // invoicing. Falls back to a plain ConsecutivoDocumento, category FV,
    // the same mechanism siguienteDocumento uses for RC/NC/ND/NT.
    const consecutivo = await this.consecutivos
      .findOneAndUpdate(
        { coPropertyId: new Types.ObjectId(coPropertyId), category: 'FV' },
        { $inc: { nextNumber: 1 } },
        { returnDocument: 'after' },
      )
      .exec();

    if (!consecutivo) {
      throw new NotFoundException(
        'Esta copropiedad no tiene una Resolución de Facturación activa ni ' +
          'un tipo de documento FV configurado. Cargá una de las dos en ' +
          'Documentos antes de emitir facturas.',
      );
    }

    return componer(consecutivo.prefix, consecutivo.nextNumber);
  }

  /**
   * Reserves up to `cantidad` sequential invoice numbers in ONE atomic
   * operation — used by a batch consolidación instead of calling
   * `siguienteFactura` once per row, which used to mean one network
   * round-trip per invoice. Returns fewer than `cantidad` (never more) when
   * the active resolution doesn't have that many left; the caller (today,
   * `LotesFacturacionService.consolidar`) is responsible for treating the
   * shortfall as the same "range exhausted, stop the batch" case
   * `siguienteFactura`'s own ConflictException represents for a single call.
   *
   * The granted COUNT is clamped server-side, atomically, via an
   * aggregation-pipeline update — the same reasoning as `siguienteFactura`'s
   * `$expr` ceiling check: computing "how many are actually left" and then
   * incrementing in a SEPARATE step would leave a window where two
   * concurrent callers both see the same leftover count and overrun the
   * range together. Clamping and incrementing in the same atomic operation
   * closes that window exactly like the existing single-number path does.
   *
   * `siguienteFactura` itself is untouched by this — it stays the correct,
   * independently tested way to reserve exactly one number for any caller
   * that doesn't need batching.
   */
  async reservarBloqueFacturas(
    coPropertyId: string,
    cantidad: number,
  ): Promise<{ numeros: NumeroAsignado[] }> {
    if (cantidad <= 0) return { numeros: [] };

    const previa = await this.resoluciones
      .findOneAndUpdate(
        {
          coPropertyId: new Types.ObjectId(coPropertyId),
          status: 'active',
        },
        [
          {
            $set: {
              _otorgados: {
                $max: [
                  0,
                  {
                    $min: [
                      cantidad,
                      {
                        $subtract: [{ $add: ['$rangeTo', 1] }, '$nextNumber'],
                      },
                    ],
                  },
                ],
              },
            },
          },
          { $set: { nextNumber: { $add: ['$nextNumber', '$_otorgados'] } } },
          { $unset: '_otorgados' },
        ],
        {
          // The pre-update document: nextNumber/rangeTo from before the
          // clamped increment, so the exact same clamp the pipeline just
          // applied server-side can be reproduced here to know how many —
          // and which — numbers were actually granted.
          returnDocument: 'before',
          // Required whenever the update argument is an array (an
          // aggregation pipeline) rather than a plain update document —
          // Mongoose refuses the array otherwise, even though the MongoDB
          // driver itself accepts it unconditionally.
          updatePipeline: true,
        },
      )
      .exec();

    if (previa) {
      const otorgados = Math.max(
        0,
        Math.min(cantidad, previa.rangeTo - previa.nextNumber + 1),
      );
      return {
        numeros: Array.from({ length: otorgados }, (_, i) => ({
          ...componer(previa.prefix, previa.nextNumber + i),
          resolucionId: previa._id,
        })),
      };
    }

    // `previa` is only null here when NO row matches
    // `{coPropertyId, status:'active'}` at all — unlike siguienteFactura's
    // `$expr` ceiling, this filter has no range condition, so an already
    // fully exhausted (but still active) resolution DOES match above and
    // is handled by the `if (previa)` branch, returning `otorgados: 0`.
    // Reaching here means there genuinely never was an active resolution —
    // the same "no resolución at all" case siguienteFactura falls back to.

    // No resolución at all — same FV consecutivo fallback siguienteFactura
    // uses, just incrementing by the whole requested count in one shot.
    const consecutivo = await this.consecutivos
      .findOneAndUpdate(
        { coPropertyId: new Types.ObjectId(coPropertyId), category: 'FV' },
        { $inc: { nextNumber: cantidad } },
        { returnDocument: 'before' },
      )
      .exec();

    if (!consecutivo) {
      throw new NotFoundException(
        'Esta copropiedad no tiene una Resolución de Facturación activa ni ' +
          'un tipo de documento FV configurado. Cargá una de las dos en ' +
          'Documentos antes de emitir facturas.',
      );
    }

    return {
      numeros: Array.from({ length: cantidad }, (_, i) =>
        componer(consecutivo.prefix, consecutivo.nextNumber + 1 + i),
      ),
    };
  }

  /**
   * Reserves the next number for a document that is not a sales invoice, by
   * its type CODE (e.g. "RC") — never a category. A building may have
   * several codes under the same category (see the note on
   * ConsecutivoDocumento), so the category alone can no longer identify a
   * row; the caller already knows which code it means.
   *
   * No upsert: the row must already exist. Auto-creating one on first use
   * made sense when a category meant exactly one row, but with several
   * possible codes per category there is no longer a single sensible
   * default to invent — an administrator declares a code in Documentos
   * before anything can be issued under it.
   *
   * `session` is optional so every existing caller keeps compiling unchanged.
   * RecibosService passes one (see design §6, "RC numbering happens inside
   * the transaction") — without it, a failed Recibo creation would still
   * consume a number, which is exactly the gap `siguienteFactura` accepts by
   * design but a Recibo's single-transaction shape does not need to.
   */
  async siguienteDocumento(
    coPropertyId: string,
    code: string,
    session?: ClientSession,
  ): Promise<NumeroAsignado> {
    const actualizado = await this.consecutivos
      .findOneAndUpdate(
        {
          coPropertyId: new Types.ObjectId(coPropertyId),
          code,
        },
        { $inc: { nextNumber: 1 } },
        // The post-increment document: its nextNumber is the one to use.
        { returnDocument: 'after', session },
      )
      .exec();

    if (!actualizado) {
      throw new NotFoundException(
        `Esta copropiedad no tiene configurado el tipo de documento "${code}". ` +
          'Cargalo en Documentos antes de emitir uno.',
      );
    }

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
        { returnDocument: 'after', upsert: true },
      )
      .exec();

    return actualizado.nextNumber;
  }
}
