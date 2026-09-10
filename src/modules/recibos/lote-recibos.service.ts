import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  LoteRecibos,
  LoteRecibosDocument,
} from '../../database/schemas/recibos/lote-recibos.schema';
import { ConsecutivoLoteRecibos } from '../../database/schemas/recibos/consecutivo-lote-recibos.schema';
import type { ConsecutivoLoteRecibosDocument } from '../../database/schemas/recibos/consecutivo-lote-recibos.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { RecibosService } from './recibos.service';
import { toLoteRecibos } from './lote-recibos.mapper';
import type {
  LoteRecibos as LoteRecibosContract,
  ErrorAplicacionLoteRecibos,
} from '../../contracts';
import type { CrearLoteRecibosDto } from './dto/crear-lote-recibos.dto';
import type { CargarFilasLoteRecibosDto } from './dto/cargar-filas-lote-recibos.dto';

/**
 * Bulk Recibo de Caja intake: a coproperty's bank hands over a flat file of
 * many payments at once (one row per inmueble) instead of someone keying in
 * a Recibo per payment. Deliberately owns NO cruce/accounting logic of its
 * own — every row that survives validation becomes a real `Recibo` through
 * `RecibosService.crear()` UNCHANGED, in `aplicacionAutomatica` mode, the
 * exact same path a single receipt already uses. This service is purely
 * the batch bookkeeping around that: which rows, whether the file's own
 * total matches what the user typed, which row became which Recibo.
 *
 * Three-stage lifecycle mirrors `LoteFacturacion`: `borrador` (opened,
 * nothing uploaded) → `cargado` (file parsed, rows resolved/validated,
 * waiting on the totalDigitado check) → `aplicado` (terminal — every row
 * without an error is now a real Recibo).
 */
@Injectable()
export class LoteRecibosService {
  constructor(
    @InjectModel(LoteRecibos.name)
    private readonly lotes: Model<LoteRecibosDocument>,
    @InjectModel(ConsecutivoLoteRecibos.name)
    private readonly consecutivos: Model<ConsecutivoLoteRecibosDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly recibosService: RecibosService,
  ) {}

  private async siguienteNumero(coPropertyId: Types.ObjectId): Promise<number> {
    const actualizado = await this.consecutivos
      .findOneAndUpdate(
        { coPropertyId },
        { $inc: { nextNumber: 1 } },
        { new: true, upsert: true },
      )
      .exec();
    return actualizado.nextNumber;
  }

  /** Batch-resolves `fullNumber` for every row that already has a
   *  `reciboId` — shared by every method below that returns a mapped
   *  contract, same reasoning as `toReciboDetalle`'s own
   *  `numerosPorDocumento`. */
  private async numerosPorRecibo(
    lote: LoteRecibosDocument,
    coPropertyId: Types.ObjectId,
  ): Promise<Map<string, string>> {
    const reciboIds = lote.filas
      .map((f) => f.reciboId)
      .filter((id): id is Types.ObjectId => id !== null);
    if (reciboIds.length === 0) return new Map();
    const recibos = await this.recibos
      .find({ coPropertyId, _id: { $in: reciboIds } })
      .exec();
    return new Map(recibos.map((r) => [r._id.toString(), r.fullNumber]));
  }

  async crear(
    accountId: string,
    dto: CrearLoteRecibosDto,
  ): Promise<LoteRecibosContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    const yaHayUno = await this.lotes
      .exists({ coPropertyId, status: { $in: ['borrador', 'cargado'] } })
      .exec();
    if (yaHayUno) {
      throw new ConflictException(
        'Ya hay un lote de recibos en curso para esta copropiedad. ' +
          'Aplícalo o cancélalo antes de crear uno nuevo.',
      );
    }

    const numero = await this.siguienteNumero(coPropertyId);
    const creado = await this.lotes.create({
      coPropertyId,
      number: numero,
      status: 'borrador',
      codigo: dto.codigo,
      medioPago: dto.medioPago,
      cuentaDestino: dto.cuentaDestino ?? null,
      totalDigitado: dto.totalDigitado,
      filas: [],
      generatedBy: accountId,
    });

    return toLoteRecibos(creado);
  }

  async findOne(id: string): Promise<LoteRecibosContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: id, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote de recibos ${id}`);
    }
    const numeros = await this.numerosPorRecibo(lote, coPropertyId);
    return toLoteRecibos(lote, numeros);
  }

  /** Most recent first — same ordering `useLotes()` already expects from
   *  Facturación's own listing. */
  async findAll(): Promise<LoteRecibosContract[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lotes = await this.lotes
      .find({ coPropertyId })
      .sort({ number: -1 })
      .exec();
    return Promise.all(
      lotes.map(async (lote) => {
        const numeros = await this.numerosPorRecibo(lote, coPropertyId);
        return toLoteRecibos(lote, numeros);
      }),
    );
  }

  /**
   * Parses no file itself — the frontend already turned the .xlsx into
   * `dto.filas` (same division of labor as
   * `LotesFacturacionService.cargarNovedades()`). Resolves each row's
   * `inmuebleCodigo` against the ACTIVE coproperty's own Inmuebles — never
   * against whatever `copropiedadCodigo` the row itself carries, which is
   * kept only as a display cross-check (the tenancy law: the tenant is
   * never trusted from client input).
   */
  async cargarArchivo(
    id: string,
    accountId: string,
    dto: CargarFilasLoteRecibosDto,
  ): Promise<LoteRecibosContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: id, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote de recibos ${id}`);
    }
    if (lote.status === 'aplicado') {
      throw new ConflictException(
        `El lote ${lote.number} ya está aplicado y no admite un nuevo archivo`,
      );
    }

    // `_id` IS the tenant id here — findById is correct, not the trap.
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    const codigoCopropiedadActiva = copropiedad?.code ?? null;

    const inmuebles = await this.inmuebles.find({ coPropertyId }).exec();
    const inmueblePorCodigo = new Map(inmuebles.map((i) => [i.code, i]));

    const filas = dto.filas.map((fila) => {
      const inmueble = inmueblePorCodigo.get(fila.inmuebleCodigo);
      let error: string | null = null;
      if (
        fila.copropiedadCodigo &&
        codigoCopropiedadActiva &&
        fila.copropiedadCodigo !== codigoCopropiedadActiva
      ) {
        error = `El código de copropiedad del archivo (${fila.copropiedadCodigo}) no coincide con la copropiedad activa`;
      } else if (!inmueble) {
        error = `El inmueble ${fila.inmuebleCodigo} no existe en esta copropiedad`;
      } else if (!inmueble.holderId) {
        error = `El inmueble ${fila.inmuebleCodigo} no tiene titular asignado`;
      }

      return {
        inmuebleCodigo: fila.inmuebleCodigo,
        copropiedadCodigo: fila.copropiedadCodigo ?? null,
        inmuebleId: inmueble?._id ?? null,
        fechaPago: new Date(fila.fechaPago),
        valorRecibido: fila.valorRecibido,
        reciboId: null,
        error,
      };
    });

    const actualizado = await this.lotes
      .findOneAndUpdate(
        { _id: id, coPropertyId },
        { $set: { filas, status: 'cargado', generatedBy: accountId } },
        { new: true },
      )
      .exec();

    return toLoteRecibos(actualizado!);
  }

  async cancelar(id: string): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: id, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote de recibos ${id}`);
    }
    if (lote.status === 'aplicado') {
      throw new ConflictException(
        `El lote ${lote.number} ya está aplicado y generó recibos reales; no puede cancelarse`,
      );
    }
    await this.lotes.deleteOne({ _id: id, coPropertyId }).exec();
  }

  /**
   * Creates one real Recibo per row without an error, via
   * `RecibosService.crear()` completely unchanged — same FIFO application,
   * same asiento, same period guards a single automatic-mode Recibo already
   * enforces. Best-effort (mirrors `LotesFacturacionService.consolidar()`):
   * a row that fails does not block the rest, its own `error` is recorded,
   * and retrying `aplicar()` afterward is safe — a row that already has a
   * `reciboId` is never re-processed.
   */
  async aplicar(
    id: string,
    accountId: string,
  ): Promise<{
    lote: LoteRecibosContract;
    errores: ErrorAplicacionLoteRecibos[];
  }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOne({ _id: id, coPropertyId }).exec();
    if (!lote) {
      throw new NotFoundException(`No se encontró el lote de recibos ${id}`);
    }
    if (lote.status !== 'cargado') {
      throw new ConflictException(
        `El lote ${lote.number} debe estar cargado antes de aplicarse`,
      );
    }

    // "Elegible" = tiene un inmueble resuelto (`cargarArchivo()` ya validó
    // el código) — independiente de si un intento ANTERIOR de `aplicar()`
    // dejó esta misma fila en error. Esa distinción importa para poder
    // reintentar: una fila sin `inmuebleId` (código de inmueble inexistente,
    // sin titular) es un problema PERMANENTE que solo se arregla recargando
    // el archivo, así que nunca cuenta ni para la suma ni para saber si el
    // lote ya terminó; una fila CON `inmuebleId` pero que falló la vez
    // pasada (p. ej. "período contable cerrado", ya reabierto) sigue siendo
    // parte del total y debe reintentarse, no quedar descartada para
    // siempre solo porque ya tiene un `error` de un intento anterior.
    const filasElegibles = lote.filas.filter((f) => f.inmuebleId !== null);
    const sumaFilas = filasElegibles.reduce(
      (sum, f) => sum + f.valorRecibido,
      0,
    );
    if (sumaFilas !== lote.totalDigitado) {
      throw new BadRequestException(
        `La suma de las filas (${sumaFilas}) no coincide con el total digitado (${lote.totalDigitado})`,
      );
    }

    const errores: ErrorAplicacionLoteRecibos[] = [];

    for (const [indice, fila] of lote.filas.entries()) {
      if (fila.reciboId !== null) continue; // ya se aplicó, no se repite
      if (!fila.inmuebleId) continue; // problema permanente, no reintentable

      fila.error = null; // limpia cualquier error de un intento anterior

      try {
        const inmueble = await this.inmuebles
          .findOne({ _id: fila.inmuebleId, coPropertyId })
          .exec();
        if (!inmueble || !inmueble.holderId) {
          throw new BadRequestException(
            `El inmueble ${fila.inmuebleCodigo} ya no tiene titular asignado`,
          );
        }

        const recibo = await this.recibosService.crear(accountId, {
          codigo: lote.codigo,
          inmuebleId: inmueble._id.toString(),
          terceroId: inmueble.holderId.toString(),
          montoRecibido: fila.valorRecibido,
          fechaRecibo: fila.fechaPago.toISOString(),
          medioPago: lote.medioPago,
          cuentaDestino: lote.cuentaDestino ?? undefined,
          aplicacionAutomatica: true,
        });

        fila.reciboId = new Types.ObjectId(recibo.id);
      } catch (err) {
        const mensaje =
          err instanceof Error ? err.message : 'Error desconocido';
        fila.error = mensaje;
        errores.push({
          fila: indice + 1,
          inmuebleCodigo: fila.inmuebleCodigo,
          mensaje,
        });
      }
    }

    // `filasElegibles` holds the SAME subdocument references the loop above
    // just mutated in place — checking `reciboId` now reflects exactly
    // which of the rows that were actually attemptable still haven't
    // succeeded. Deliberately NOT `lote.filas.every(...)`: a row without an
    // `inmuebleId` is a permanent problem this same lote can never resolve,
    // and must never be what keeps the batch from ever completing.
    const todasResueltas = filasElegibles.every((f) => f.reciboId !== null);
    lote.status = todasResueltas ? 'aplicado' : 'cargado';
    // `filas` is an array of `_id: false` subdocuments mutated in place
    // above (`fila.reciboId = ...`) — marking it explicitly guarantees
    // Mongoose persists those changes regardless of how reliably it would
    // have inferred the mutation on its own.
    lote.markModified('filas');
    await lote.save();

    const numeros = await this.numerosPorRecibo(lote, coPropertyId);
    return { lote: toLoteRecibos(lote, numeros), errores };
  }
}
