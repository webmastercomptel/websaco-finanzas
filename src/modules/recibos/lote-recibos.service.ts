import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue, QueueEvents } from 'bullmq';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  LoteRecibos,
  LoteRecibosDocument,
  LoteRecibosFila,
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
import { NumeracionService } from '../../common/numeracion/numeracion.service';
import type { NumeroAsignado } from '../../common/numeracion/numeracion.service';
import { RecibosService } from './recibos.service';
import { toLoteRecibos } from './lote-recibos.mapper';
import type {
  LoteRecibos as LoteRecibosContract,
  ErrorAplicacionLoteRecibos,
} from '../../contracts';
import type { CrearLoteRecibosDto } from './dto/crear-lote-recibos.dto';
import type { CargarFilasLoteRecibosDto } from './dto/cargar-filas-lote-recibos.dto';
import {
  NOMBRE_COLA_APLICACION_LOTE_RECIBOS,
  NOMBRE_TRABAJO_APLICACION_LOTE_RECIBOS,
  EVENTOS_COLA_APLICACION_LOTE_RECIBOS,
  type DatosTrabajoAplicacionLoteRecibos,
  type ResultadoAplicacionLoteRecibos,
} from './colas/aplicacion-lote-recibos.constants';

/** Rows per shared transaction — matches
 *  `TAMANO_TANDA_CONSOLIDACION` (facturación) exactly; same conservative
 *  default for the same shared/free-tier Atlas cluster. */
const TAMANO_TANDA_APLICACION_LOTE_RECIBOS = 20;
/** Tandas in flight at once — matches
 *  `CONCURRENCIA_TANDAS_CONSOLIDACION`. Concurrency is only ever ACROSS
 *  tandas; a tanda's own rows run sequentially inside its one shared
 *  session (a session's operations cannot run concurrently against
 *  themselves). */
const CONCURRENCIA_TANDAS_APLICACION_LOTE_RECIBOS = 4;

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
    private readonly numeracion: NumeracionService,
    @InjectConnection() private readonly connection: Connection,
    @InjectQueue(NOMBRE_COLA_APLICACION_LOTE_RECIBOS)
    private readonly cola?: Queue<
      DatosTrabajoAplicacionLoteRecibos,
      ResultadoAplicacionLoteRecibos
    >,
    @Inject(EVENTOS_COLA_APLICACION_LOTE_RECIBOS)
    private readonly eventosCola?: QueueEvents,
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
      creadoEn: new Date(),
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
   * Resolves the tenant on the request thread (CLS context is only valid
   * here, not inside a queued job — same reasoning as
   * `LotesFacturacionService.consolidar()`), then either enqueues the real
   * work or, when no queue is wired (hand-constructed unit tests), runs it
   * inline — mirrors that same method's own `if (!this.cola ...)` fallback.
   */
  async aplicar(
    id: string,
    accountId: string,
  ): Promise<ResultadoAplicacionLoteRecibos> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (!this.cola || !this.eventosCola) {
      return this.ejecutarAplicacion(id, coPropertyId, accountId);
    }

    const trabajo = await this.cola.add(
      NOMBRE_TRABAJO_APLICACION_LOTE_RECIBOS,
      { loteId: id, coPropertyId: coPropertyId.toString(), accountId },
    );
    return trabajo.waitUntilFinished(this.eventosCola);
  }

  /**
   * Creates one real Recibo per row without an error, via
   * `RecibosService.prepararCreacion`/`crearEnSesion` — same FIFO
   * application, same asiento, same period guards a single automatic-mode
   * Recibo already enforces, now run inside a transaction THIS method opens
   * and shares across a whole tanda of rows, instead of one transaction per
   * row. Best-effort per row within what a tanda's rollback allows (mirrors
   * `LotesFacturacionService.ejecutarConsolidacion()`): a row that fails
   * takes its WHOLE tanda down with it — every row in that tanda is
   * recorded as errored, none of them persist a `reciboId` — and retrying
   * `aplicar()` afterward is safe, since a row that already has a
   * `reciboId` is never re-processed.
   *
   * Tandas run with bounded concurrency
   * (`CONCURRENCIA_TANDAS_APLICACION_LOTE_RECIBOS`); each tanda's own rows
   * run strictly sequentially inside that tanda's one shared session.
   */
  async ejecutarAplicacion(
    id: string,
    coPropertyId: Types.ObjectId,
    accountId: string,
    job?: Job<
      DatosTrabajoAplicacionLoteRecibos,
      ResultadoAplicacionLoteRecibos
    >,
  ): Promise<ResultadoAplicacionLoteRecibos> {
    void job; // reserved for future progress reporting — see plan's Review Focus
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
    const pendientes = lote.filas
      .map((fila, indice) => ({ fila, indice }))
      .filter(({ fila }) => fila.reciboId === null && fila.inmuebleId !== null);

    // Reserved ONCE, up front, OUTSIDE every tanda's transaction — see
    // `NumeracionService.reservarBloqueDocumentos`'s own docblock for why:
    // every row in this lote shares the SAME `(coPropertyId, lote.codigo)`
    // counter, so letting each tanda's transaction `$inc` it individually
    // would write-conflict concurrent tandas against each other.
    const { numeros: numerosReservados } =
      await this.numeracion.reservarBloqueDocumentos(
        coPropertyId.toString(),
        lote.codigo,
        pendientes.length,
      );
    const pendientesConNumero = pendientes.map((p, i) => ({
      ...p,
      numero: numerosReservados[i],
    }));

    const tandas = this.dividirEnTandas(
      pendientesConNumero,
      TAMANO_TANDA_APLICACION_LOTE_RECIBOS,
    );

    await this.conLimiteDeConcurrencia(
      tandas,
      CONCURRENCIA_TANDAS_APLICACION_LOTE_RECIBOS,
      (tanda) =>
        this.procesarTanda(tanda, { lote, coPropertyId, accountId, errores }),
    );

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

  /** Splits `items` into fixed-size groups, in order — pure, no I/O. Two
   *  rows for the same `inmuebleId` land in different tandas whenever
   *  they're more than `tamano` positions apart in `pendientes`; this
   *  function has no notion of `inmuebleId` at all, by design (grouping by
   *  inmueble would need cross-tanda FIFO ordering guarantees this plan
   *  deliberately does not build — see the plan's Review Focus). */
  private dividirEnTandas<T>(items: T[], tamano: number): T[][] {
    const tandas: T[][] = [];
    for (let i = 0; i < items.length; i += tamano) {
      tandas.push(items.slice(i, i + tamano));
    }
    return tandas;
  }

  /**
   * One shared Mongo transaction for every row in `tanda` — opens its own
   * session (never reused across tandas, so tandas running concurrently
   * via `conLimiteDeConcurrencia` never share one), calls
   * `RecibosService.crearEnSesion` sequentially per row inside it, and on
   * ANY row's failure, the whole tanda's transaction aborts and EVERY row
   * in it is recorded as errored — mirrors
   * `LotesFacturacionService.procesarTanda()`'s own catch-all exactly.
   * `prepararCreacion` runs per row INSIDE this transaction's callback (its
   * own reads carry no `session`, same as `RecibosService.crear()`'s own
   * pre-transaction placement — it just can't run any earlier here, since
   * the whole point is one shared transaction per tanda, not one per row) —
   * a validation failure there aborts the row's place in the tanda the same
   * way a `crearEnSesion` failure would, since both are awaited inside the
   * same try block below. A transient-transaction retry re-runs the whole
   * callback, so a row whose `prepararCreacion` did a `copropiedades
   * .findById` (no `cuentaDestino` on the dto) pays that read again on
   * retry — harmless, just not free.
   *
   * Two things a naive version of this got wrong, both fixed here:
   *  - A row's `fila.reciboId` is set in-memory the instant its
   *    `crearEnSesion` call resolves, BEFORE the tanda's transaction
   *    actually commits. If a LATER row in the same tanda then fails, Mongo
   *    rolls back every write the earlier row made — but that in-memory
   *    `reciboId` would otherwise survive into `lote.save()`, pointing at a
   *    Recibo that was never actually persisted. The catch below resets
   *    `fila.reciboId = null` for every row in the tanda, not just the one
   *    that threw.
   *  - `this.connection.startSession()` itself can reject (e.g. the pool is
   *    exhausted) — this now happens INSIDE the try, so `procesarTanda`
   *    never rejects and `Promise.all` in `conLimiteDeConcurrencia` never
   *    aborts the whole run because of one tanda's connection hiccup.
   *
   * `tanda`'s element type is the same `{ fila, indice, numero }` shape
   * `ejecutarAplicacion`'s own `pendientesConNumero` array already builds
   * inline, where `fila` is a `LoteRecibosFila` subdocument (the schema's
   * own row type, `database/schemas/recibos/lote-recibos.schema.ts:20`) and
   * `numero` is this row's pre-reserved `NumeroAsignado` (reserved as a
   * whole block before any tanda opens — see `ejecutarAplicacion`).
   */
  private async procesarTanda(
    tanda: { fila: LoteRecibosFila; indice: number; numero: NumeroAsignado }[],
    ctx: {
      lote: LoteRecibosDocument;
      coPropertyId: Types.ObjectId;
      accountId: string;
      errores: ErrorAplicacionLoteRecibos[];
    },
  ): Promise<void> {
    let sesion: ClientSession | undefined;
    let indiceCulpable: number | null = null;
    try {
      sesion = await this.connection.startSession();
      const session = sesion;
      await session.withTransaction(async () => {
        for (const { fila, indice, numero } of tanda) {
          fila.error = null; // limpia cualquier error de un intento anterior
          try {
            const inmueble = await this.inmuebles
              .findOne({ _id: fila.inmuebleId, coPropertyId: ctx.coPropertyId })
              .session(session)
              .exec();
            if (!inmueble || !inmueble.holderId) {
              throw new BadRequestException(
                `El inmueble ${fila.inmuebleCodigo} ya no tiene titular asignado`,
              );
            }

            const dto = {
              codigo: ctx.lote.codigo,
              inmuebleId: inmueble._id.toString(),
              terceroId: inmueble.holderId.toString(),
              montoRecibido: fila.valorRecibido,
              fechaRecibo: fila.fechaPago.toISOString(),
              medioPago: ctx.lote.medioPago,
              cuentaDestino: ctx.lote.cuentaDestino ?? undefined,
              aplicacionAutomatica: true as const,
            };

            const contexto = await this.recibosService.prepararCreacion(
              dto,
              ctx.coPropertyId,
            );
            const recibo = await this.recibosService.crearEnSesion(
              session,
              ctx.accountId,
              dto,
              contexto,
              numero,
            );
            fila.reciboId = new Types.ObjectId(recibo.id);
          } catch (err) {
            indiceCulpable = indice;
            throw err;
          }
        }
      });
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : 'Error desconocido';
      for (const { fila, indice } of tanda) {
        // La transacción entera de la tanda se revirtió — ninguna fila de
        // esta tanda quedó realmente persistida, sin importar qué reciboId
        // haya quedado asignado en memoria antes de que la fila culpable
        // fallara.
        fila.reciboId = null;
        fila.error =
          indice === indiceCulpable
            ? mensaje
            : `Revertida junto con la fila ${(indiceCulpable ?? indice) + 1}, que falló: ${mensaje}`;
        ctx.errores.push({
          fila: indice + 1,
          inmuebleCodigo: fila.inmuebleCodigo,
          mensaje: fila.error,
        });
      }
    } finally {
      await sesion?.endSession();
    }
  }

  /** Bounded-concurrency worker pool — same shape as
   *  `LotesFacturacionService`'s own private helper of the same name.
   *  Duplicated rather than extracted to a shared util: these two callers
   *  belong to independently-evolving modules and the helper is ~15 lines;
   *  sharing it would couple them for no current benefit. Now runs over
   *  TANDAS, not individual rows. */
  private async conLimiteDeConcurrencia<T>(
    items: T[],
    concurrencia: number,
    tarea: (item: T) => Promise<void>,
  ): Promise<void> {
    let siguiente = 0;
    const trabajador = async (): Promise<void> => {
      while (siguiente < items.length) {
        const indice = siguiente;
        siguiente += 1;
        await tarea(items[indice]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrencia, items.length) }, () =>
        trabajador(),
      ),
    );
  }
}
