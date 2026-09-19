import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  SaldoInicialAnticipo,
  SaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import {
  LoteSaldoInicialAnticipo,
  LoteSaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/lote-saldo-inicial-anticipo.schema';
import {
  ConsecutivoSaldoInicialAnticipo,
  ConsecutivoSaldoInicialAnticipoDocument,
} from '../../database/schemas/saldos-iniciales/consecutivo-saldo-inicial-anticipo.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  SaldoDocumentoOrigen,
  SaldoDocumentoOrigenDocument,
} from '../../database/schemas/recibos/saldo-documento-origen.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  ProgresoImportacionService,
  type ProgresoActual,
} from '../inmuebles/progreso-importacion.service';
import { toSaldoInicialAnticipo } from './saldos-iniciales-anticipo.mapper';
import type {
  ResultadoImportacionSaldosInicialesAnticipo,
  SaldoInicialAnticipo as SaldoInicialAnticipoContract,
} from '../../contracts';
import type { ImportarSaldosInicialesAnticipoDto } from './dto/importar-saldos-iniciales-anticipo.dto';
import type { AnularSaldoInicialAnticipoDto } from './dto/anular-saldo-inicial-anticipo.dto';

/**
 * Imports opening ANTICIPO (credit) balances brought from a client's
 * previous system — see `SaldoInicialAnticipo`'s own schema docblock for why
 * this is its own document rather than a synthetic `Recibo`. The import
 * touches ONLY this document, its own internal ordinal counter, and the
 * shared `SaldoDocumentoOrigen` row (`tipoDocumento: 'SI'`) that lets
 * `NotasAnticipoService` draw it down later exactly like a real Recibo's
 * `unappliedAmount` — never `Recibo`, `AsientoContable`, nor any real
 * consecutivo.
 */
@Injectable()
export class SaldosInicialesAnticipoService {
  constructor(
    @InjectModel(SaldoInicialAnticipo.name)
    private readonly saldosInicialesAnticipo: Model<SaldoInicialAnticipoDocument>,
    @InjectModel(LoteSaldoInicialAnticipo.name)
    private readonly lotes: Model<LoteSaldoInicialAnticipoDocument>,
    @InjectModel(ConsecutivoSaldoInicialAnticipo.name)
    private readonly consecutivos: Model<ConsecutivoSaldoInicialAnticipoDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(SaldoDocumentoOrigen.name)
    private readonly saldoDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
    private readonly tenant: TenantContextService,
    private readonly progreso: ProgresoImportacionService,
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

  private async siguienteNumero(
    coPropertyId: Types.ObjectId,
    session: ClientSession,
  ): Promise<number> {
    const actualizado = await this.consecutivos
      .findOneAndUpdate(
        { coPropertyId },
        { $inc: { nextNumber: 1 } },
        { new: true, upsert: true, session },
      )
      .exec();
    return actualizado.nextNumber;
  }

  /**
   * Imports every row independently — a bad row (wrong código de
   * copropiedad, unknown inmueble, a duplicate of an already-imported
   * document) fails only that row, mirroring
   * `SaldosInicialesService.importar()`. Each successful row runs in its own
   * transaction: the Saldo Inicial de Anticipo itself, plus the
   * `SaldoDocumentoOrigen` row it seeds, land together or not at all.
   */
  async importar(
    accountId: string,
    dto: ImportarSaldosInicialesAnticipoDto,
  ): Promise<ResultadoImportacionSaldosInicialesAnticipo> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap (see
    // backend/CLAUDE.md's own note on this exact mistake).
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    // One-shot guard — this import is meant to happen exactly once per
    // coproperty. Voiding every existing active record (via `anular()`)
    // clears this and allows a fresh attempt, without ever deleting
    // anything.
    const activos = await this.saldosInicialesAnticipo
      .countDocuments({ coPropertyId, status: 'activo' })
      .exec();
    if (activos > 0) {
      throw new ConflictException(
        'Esta copropiedad ya tiene saldos iniciales de anticipo activos. Anulá los existentes antes de cargar un archivo nuevo.',
      );
    }

    // Whole-file validation pass — no DB writes yet. Every problem found is
    // collected, not just the first, and if anything fails NOTHING below
    // this block runs: no lote, no rows, no progress tracking.
    const codigos = [...new Set(dto.filas.map((f) => f.codigoInmueble))];
    const inmueblesEncontrados = await this.inmuebles
      .find({ coPropertyId, code: { $in: codigos } })
      .exec();
    const inmueblePorCodigo = new Map(
      inmueblesEncontrados.map((i) => [i.code, i]),
    );

    const erroresValidacion: ResultadoImportacionSaldosInicialesAnticipo['errores'] =
      [];
    const vistos = new Set<string>();
    let sumaValores = 0;

    dto.filas.forEach((fila, indice) => {
      const numeroFila = indice + 1;
      if (fila.codigoCopropiedad !== copropiedad.code) {
        erroresValidacion.push({
          fila: numeroFila,
          inmuebleCodigo: fila.codigoInmueble,
          mensaje: `El código de copropiedad "${fila.codigoCopropiedad}" no coincide con el de la copropiedad activa (${copropiedad.code})`,
        });
        return;
      }
      if (!inmueblePorCodigo.has(fila.codigoInmueble)) {
        erroresValidacion.push({
          fila: numeroFila,
          inmuebleCodigo: fila.codigoInmueble,
          mensaje: `No existe un inmueble con el código ${fila.codigoInmueble} en esta copropiedad`,
        });
        return;
      }
      if (new Date(fila.fecha).getTime() > new Date(dto.fechaCorte).getTime()) {
        erroresValidacion.push({
          fila: numeroFila,
          inmuebleCodigo: fila.codigoInmueble,
          mensaje: `La fecha ${fila.fecha} es posterior a la fecha de corte (${dto.fechaCorte})`,
        });
        return;
      }
      const clave = `${fila.codigoInmueble}|${fila.tipoDocumento}|${fila.numero}`;
      if (vistos.has(clave)) {
        erroresValidacion.push({
          fila: numeroFila,
          inmuebleCodigo: fila.codigoInmueble,
          mensaje: `El documento ${fila.tipoDocumento} ${fila.numero} del inmueble ${fila.codigoInmueble} está repetido en este archivo`,
        });
        return;
      }
      vistos.add(clave);
      sumaValores += fila.valor;
    });

    if (sumaValores !== dto.valorTotal) {
      erroresValidacion.push({
        fila: 0,
        inmuebleCodigo: null,
        mensaje: `La suma de los valores del archivo (${sumaValores}) no coincide con el valor total esperado (${dto.valorTotal})`,
      });
    }

    if (erroresValidacion.length > 0) {
      return {
        total: dto.filas.length,
        importados: 0,
        errores: erroresValidacion,
      };
    }

    // Validation passed — every row below is now expected to succeed. The
    // per-row try/catch that follows stays only as a defensive safety net
    // for genuine runtime failures (e.g. a transaction conflict), not as
    // the primary validation path anymore.
    const [lote] = await this.lotes.create([
      {
        coPropertyId,
        totalFilas: 0,
        totalMonto: 0,
        importedBy: accountId,
      },
    ]);

    const errores: ResultadoImportacionSaldosInicialesAnticipo['errores'] = [];
    let importados = 0;
    let totalMonto = 0;

    const total = dto.filas.length;
    const intervalo = this.progreso.intervalo(total);
    await this.progreso.iniciar(
      coPropertyId,
      'saldos-iniciales-anticipo',
      total,
    );

    try {
      for (const [indice, fila] of dto.filas.entries()) {
        try {
          if (fila.codigoCopropiedad !== copropiedad.code) {
            throw new Error(
              `El código de copropiedad "${fila.codigoCopropiedad}" no coincide con el de la copropiedad activa (${copropiedad.code})`,
            );
          }

          const inmueble = await this.inmuebles
            .findOne({ coPropertyId, code: fila.codigoInmueble })
            .exec();
          if (!inmueble) {
            throw new Error(
              `No existe un inmueble con el código ${fila.codigoInmueble} en esta copropiedad`,
            );
          }

          await this.transaccion(async (session) => {
            const numero = await this.siguienteNumero(coPropertyId, session);

            const [creado] = await this.saldosInicialesAnticipo.create(
              [
                {
                  coPropertyId,
                  loteId: lote._id,
                  inmuebleId: inmueble._id,
                  // Frozen from the unit's CURRENT titular — same source
                  // `NotaDebitoService`/`NotaCreditoService` read for their
                  // own `terceroId` (`Inmueble.holderId`).
                  terceroId: inmueble.holderId,
                  unitCode: inmueble.code,
                  number: numero,
                  tipoDocumentoOriginal: fila.tipoDocumento,
                  numeroOriginal: fila.numero,
                  fullNumber: `${fila.tipoDocumento} ${fila.numero}`,
                  receivedDate: new Date(fila.fecha),
                  montoOriginal: fila.valor,
                  status: 'activo',
                  generatedBy: accountId,
                },
              ],
              { session },
            );

            await this.saldoDocumentoOrigen.create(
              [
                {
                  coPropertyId,
                  tipoDocumento: 'SI',
                  documentoId: creado._id,
                  montoOriginal: fila.valor,
                  saldoDisponible: fila.valor,
                },
              ],
              { session },
            );
          });

          importados += 1;
          totalMonto += fila.valor;
        } catch (err) {
          errores.push({
            fila: indice + 1,
            inmuebleCodigo: fila.codigoInmueble ?? null,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }

        const completadas = indice + 1;
        if (completadas % intervalo === 0 || completadas === total) {
          await this.progreso.actualizar(
            coPropertyId,
            'saldos-iniciales-anticipo',
            completadas,
            total,
          );
        }
      }
    } finally {
      await this.progreso.finalizar(coPropertyId, 'saldos-iniciales-anticipo');
    }

    await this.lotes
      .updateOne(
        { _id: lote._id },
        { $set: { totalFilas: importados, totalMonto } },
      )
      .exec();

    return { total: dto.filas.length, importados, errores };
  }

  /** Null while no import is currently running for the active coproperty —
   *  see `ProgresoImportacionService.obtener`. */
  async obtenerProgresoImportacion(): Promise<ProgresoActual | null> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.progreso.obtener(coPropertyId, 'saldos-iniciales-anticipo');
  }

  async listar(): Promise<SaldoInicialAnticipoContract[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const [documentos, inmuebles] = await Promise.all([
      this.saldosInicialesAnticipo
        .find({ coPropertyId })
        .sort({ createdAt: -1 })
        .exec(),
      this.inmuebles.find({ coPropertyId }).exec(),
    ]);
    const inmuebleCodigoPorId = new Map(
      inmuebles.map((i) => [i._id.toString(), i.code]),
    );
    const saldos = documentos.length
      ? await this.saldoDocumentoOrigen
          .find({ documentoId: { $in: documentos.map((d) => d._id) } })
          .exec()
      : [];
    const saldoDisponiblePorId = new Map(
      saldos.map((s) => [s.documentoId.toString(), s.saldoDisponible]),
    );

    return documentos.map((doc) =>
      toSaldoInicialAnticipo(
        doc,
        inmuebleCodigoPorId.get(doc.inmuebleId.toString()) ?? '',
        saldoDisponiblePorId.get(doc._id.toString()) ?? 0,
      ),
    );
  }

  /**
   * Voids a Saldo Inicial de Anticipo — a state transition (never `delete`,
   * the audit law), reversing only whatever `saldoDisponible` is STILL
   * available. Whatever a Nota de Anticipo already drew from it stays drawn:
   * that was its own real, independent transaction, and undoing it here
   * would erase an application that genuinely happened — same reasoning as
   * `SaldosInicialesService.anular()` on the charge side.
   */
  async anular(
    id: string,
    dto: AnularSaldoInicialAnticipoDto,
    accountId: string,
  ): Promise<SaldoInicialAnticipoContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    return this.transaccion(async (session) => {
      const saldoInicialAnticipoId = new Types.ObjectId(id);
      const doc = await this.saldosInicialesAnticipo
        .findOne({ _id: saldoInicialAnticipoId, coPropertyId })
        .session(session)
        .exec();
      if (!doc) {
        throw new NotFoundException(
          `No se encontró el saldo inicial de anticipo ${id}`,
        );
      }
      if (doc.status === 'anulado') {
        throw new ConflictException(
          `El saldo inicial de anticipo ${doc.numeroOriginal} ya está anulado`,
        );
      }

      const saldoOrigen = await this.saldoDocumentoOrigen
        .findOne({ documentoId: saldoInicialAnticipoId })
        .session(session)
        .exec();
      if ((saldoOrigen?.saldoDisponible ?? 0) > 0) {
        await this.saldoDocumentoOrigen
          .updateOne(
            { documentoId: saldoInicialAnticipoId },
            { $set: { saldoDisponible: 0 } },
            { session },
          )
          .exec();
      }

      await this.saldosInicialesAnticipo
        .updateOne(
          { _id: saldoInicialAnticipoId, coPropertyId },
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

      const final = await this.saldosInicialesAnticipo
        .findOne({ _id: saldoInicialAnticipoId, coPropertyId })
        .session(session)
        .exec();
      return toSaldoInicialAnticipo(final!, doc.unitCode, 0);
    });
  }
}
