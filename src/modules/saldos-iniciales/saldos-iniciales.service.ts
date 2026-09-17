import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import {
  LoteSaldoInicial,
  LoteSaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/lote-saldo-inicial.schema';
import {
  ConsecutivoSaldoInicial,
  ConsecutivoSaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/consecutivo-saldo-inicial.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
import {
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import {
  ProgresoImportacionService,
  type ProgresoActual,
} from '../inmuebles/progreso-importacion.service';
import { toSaldoInicial } from './saldos-iniciales.mapper';
import type {
  ResultadoImportacionSaldosIniciales,
  SaldoInicial as SaldoInicialContract,
} from '../../contracts';
import type { ImportarSaldosInicialesDto } from './dto/importar-saldos-iniciales.dto';
import type { AnularSaldoInicialDto } from './dto/anular-saldo-inicial.dto';

/**
 * Imports opening cartera balances brought from a client's previous system —
 * see `SaldoInicial`'s own schema docblock for why this is a THIRD cartera
 * charge document rather than a fake Factura/Nota Débito. The import touches
 * ONLY this document, its own internal ordinal counter, and the three
 * shared cartera ledgers every other charge document seeds
 * (`SaldoTotalDocumento`/`CarteraPorDocumento`/`SaldoCartera`) — never
 * `Factura`, `NotaDebito`, `Recibo`, `NotaCredito`, `AsientoContable`, nor
 * any real consecutivo (see the module's own README-equivalent, the plan
 * this was built from).
 */
@Injectable()
export class SaldosInicialesService {
  constructor(
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales: Model<SaldoInicialDocument>,
    @InjectModel(LoteSaldoInicial.name)
    private readonly lotes: Model<LoteSaldoInicialDocument>,
    @InjectModel(ConsecutivoSaldoInicial.name)
    private readonly consecutivos: Model<ConsecutivoSaldoInicialDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptosCobro: Model<ConceptoCobroDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldosCartera: Model<SaldoCarteraDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
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
   * copropiedad, unknown inmueble/concepto, a total that doesn't match its
   * own cargos, a duplicate of an already-imported document) fails only
   * that row, mirroring `ValoresRecurrentesService.importarMasivo`. Each
   * successful row runs in its own transaction: the Saldo Inicial itself,
   * plus the three shared cartera ledgers, land together or not at all.
   */
  async importar(
    accountId: string,
    dto: ImportarSaldosInicialesDto,
  ): Promise<ResultadoImportacionSaldosIniciales> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    // `_id` IS the tenant id here — findById is correct, not the trap (see
    // backend/CLAUDE.md's own note on this exact mistake).
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const conceptos = await this.conceptosCobro
      .find({ coPropertyId })
      .populate('cuentaDebitoId', 'code')
      .populate('cuentaCreditoId', 'code')
      .exec();
    const conceptoPorId = new Map(conceptos.map((c) => [c._id.toString(), c]));

    // One batch header for the WHOLE file (traceability only — never a real
    // consecutivo, see `LoteSaldoInicial`'s own docblock), updated with the
    // final tallies once every row has been attempted.
    const [lote] = await this.lotes.create([
      {
        coPropertyId,
        totalFilas: 0,
        totalMonto: 0,
        importedBy: accountId,
      },
    ]);

    const errores: ResultadoImportacionSaldosIniciales['errores'] = [];
    let importados = 0;
    let totalMonto = 0;

    // Coarse progress signal for the frontend to poll while this request is
    // in flight — same pattern as `InmueblesService.importar`'s own note on
    // `ProgresoImportacionService`. Cleared in `finally` so a thrown error
    // never leaves a stuck row behind.
    const total = dto.filas.length;
    const intervalo = this.progreso.intervalo(total);
    await this.progreso.iniciar(coPropertyId, 'saldos-iniciales', total);

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

          const lineas = fila.cargos.map((cargo) => {
            const concepto = conceptoPorId.get(cargo.conceptoId);
            if (!concepto) {
              throw new Error(
                `No existe el concepto de cobro ${cargo.conceptoId}`,
              );
            }
            return {
              conceptoId: concepto._id,
              conceptName: concepto.name,
              accountingReceivableAccount: codigoDeCuentaContable(
                concepto.cuentaDebitoId,
              ),
              accountingIncomeAccount: codigoDeCuentaContable(
                concepto.cuentaCreditoId,
              ),
              conceptKind: concepto.kind,
              montoOriginal: cargo.monto,
            };
          });
          const total = lineas.reduce((sum, l) => sum + l.montoOriginal, 0);

          await this.transaccion(async (session) => {
            const numero = await this.siguienteNumero(coPropertyId, session);

            const [creado] = await this.saldosIniciales.create(
              [
                {
                  coPropertyId,
                  loteId: lote._id,
                  inmuebleId: inmueble._id,
                  unitCode: inmueble.code,
                  number: numero,
                  tipoDocumentoOriginal: fila.tipoDocumento,
                  numeroOriginal: fila.numero,
                  fecha: new Date(fila.fecha),
                  fechaVencimiento: new Date(fila.fechaVencimiento),
                  lines: lineas,
                  total,
                  status: 'activo',
                  generatedBy: accountId,
                },
              ],
              { session },
            );

            await this.saldoTotalDocumento.create(
              [
                {
                  coPropertyId,
                  tipoDocumento: 'SI',
                  documentoId: creado._id,
                  total,
                  saldoPendiente: total,
                },
              ],
              { session },
            );

            for (const linea of lineas) {
              // Same `$ifNull`-based upsert `ajustarCarteraPorDocumento`
              // (cruce.util.ts) uses — a brand-new row here, always, since
              // this document was never seeded before.
              const saldoAnteriorRow = await this.saldosCartera
                .findOne({
                  coPropertyId,
                  inmuebleId: inmueble._id,
                  conceptoId: linea.conceptoId,
                })
                .session(session)
                .exec();
              const saldoAnterior = saldoAnteriorRow?.balance ?? 0;

              await this.carteraPorDocumento.create(
                [
                  {
                    coPropertyId,
                    inmuebleId: inmueble._id,
                    tipoDocumento: 'SI',
                    documentoId: creado._id,
                    conceptoId: linea.conceptoId,
                    montoOriginal: linea.montoOriginal,
                    saldoPendiente: linea.montoOriginal,
                    saldoAnterior,
                    saldoNuevo: saldoAnterior + linea.montoOriginal,
                  },
                ],
                { session },
              );

              await this.saldosCartera
                .findOneAndUpdate(
                  {
                    coPropertyId,
                    inmuebleId: inmueble._id,
                    conceptoId: linea.conceptoId,
                  },
                  { $inc: { balance: linea.montoOriginal } },
                  { upsert: true, session },
                )
                .exec();
            }
          });

          importados += 1;
          totalMonto += total;
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
            'saldos-iniciales',
            completadas,
            total,
          );
        }
      }
    } finally {
      await this.progreso.finalizar(coPropertyId, 'saldos-iniciales');
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
    return this.progreso.obtener(coPropertyId, 'saldos-iniciales');
  }

  async listar(): Promise<SaldoInicialContract[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const [documentos, inmuebles] = await Promise.all([
      this.saldosIniciales
        .find({ coPropertyId })
        .sort({ createdAt: -1 })
        .exec(),
      this.inmuebles.find({ coPropertyId }).exec(),
    ]);
    const inmuebleCodigoPorId = new Map(
      inmuebles.map((i) => [i._id.toString(), i.code]),
    );
    const saldosTotales = documentos.length
      ? await this.saldoTotalDocumento
          .find({ documentoId: { $in: documentos.map((d) => d._id) } })
          .exec()
      : [];
    const saldoPendientePorId = new Map(
      saldosTotales.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );

    return documentos.map((doc) =>
      toSaldoInicial(
        doc,
        inmuebleCodigoPorId.get(doc.inmuebleId.toString()) ?? '',
        saldoPendientePorId.get(doc._id.toString()) ?? 0,
      ),
    );
  }

  /**
   * Voids a Saldo Inicial — a state transition (never `delete`, the audit
   * law), reversing only whatever `saldoPendiente` is STILL outstanding.
   * Whatever a real Recibo/Nota Crédito already collected stays collected:
   * that was its own real, independent transaction, and undoing it here
   * would erase money that genuinely moved.
   */
  async anular(
    id: string,
    dto: AnularSaldoInicialDto,
    accountId: string,
  ): Promise<SaldoInicialContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    return this.transaccion(async (session) => {
      const saldoInicialId = new Types.ObjectId(id);
      const doc = await this.saldosIniciales
        .findOne({ _id: saldoInicialId, coPropertyId })
        .session(session)
        .exec();
      if (!doc) {
        throw new NotFoundException(`No se encontró el saldo inicial ${id}`);
      }
      if (doc.status === 'anulado') {
        throw new ConflictException(
          `El saldo inicial ${doc.numeroOriginal} ya está anulado`,
        );
      }

      const saldoTotal = await this.saldoTotalDocumento
        .findOne({ documentoId: saldoInicialId })
        .session(session)
        .exec();
      const restante = saldoTotal?.saldoPendiente ?? 0;

      if (restante > 0) {
        const filasCartera = await this.carteraPorDocumento
          .find({ documentoId: saldoInicialId })
          .session(session)
          .exec();
        for (const fila of filasCartera) {
          if (fila.saldoPendiente <= 0) continue;
          await this.saldosCartera
            .findOneAndUpdate(
              {
                coPropertyId,
                inmuebleId: doc.inmuebleId,
                conceptoId: fila.conceptoId,
              },
              { $inc: { balance: -fila.saldoPendiente } },
              { session },
            )
            .exec();
          await this.carteraPorDocumento
            .updateOne(
              { _id: fila._id },
              { $set: { saldoPendiente: 0 } },
              { session },
            )
            .exec();
        }
        await this.saldoTotalDocumento
          .updateOne(
            { documentoId: saldoInicialId },
            { $set: { saldoPendiente: 0 } },
            { session },
          )
          .exec();
      }

      await this.saldosIniciales
        .updateOne(
          { _id: saldoInicialId, coPropertyId },
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

      const final = await this.saldosIniciales
        .findOne({ _id: saldoInicialId, coPropertyId })
        .session(session)
        .exec();
      const inmueble = await this.inmuebles
        .findOne({ _id: doc.inmuebleId, coPropertyId })
        .session(session)
        .exec();
      return toSaldoInicial(final!, inmueble?.code ?? '', 0);
    });
  }
}
