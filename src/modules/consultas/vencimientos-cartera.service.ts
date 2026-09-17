import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  NotaDebito,
  NotaDebitoDocument,
} from '../../database/schemas/notas-debito/nota-debito.schema';
import {
  SaldoInicial,
  SaldoInicialDocument,
} from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import {
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { activeAsOf, finDelDiaCorte } from './cartera-historica.util';
import type {
  FilaVencimientoCartera,
  RangoVencimiento,
  RangoVencimientoCartera,
  RespuestaVencimientosCartera,
} from '../../contracts';
import type { ConsultarVencimientosCarteraDto } from './dto/consultar-vencimientos-cartera.dto';

/** Compute days overdue: max(0, floor((corte - referenceDate) / day)).
 *  UTC truncation, never local — see `CarteraGeneralService`'s own copy of
 *  this function for why local `setHours` would silently shift every count
 *  by a day on a machine not itself running in UTC. */
const calcularDiasMora = (fechaReferencia: Date, corte: Date): number => {
  const c = new Date(corte);
  c.setUTCHours(0, 0, 0, 0);
  const ref = new Date(fechaReferencia);
  ref.setUTCHours(0, 0, 0, 0);
  const diff = c.getTime() - ref.getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
};

/** Fixed aging buckets, in display order — never a per-coproperty catalog. */
const RANGOS: { key: RangoVencimiento; etiqueta: string; max: number }[] = [
  { key: 'dias_1_30', etiqueta: 'Vencida de 1-30', max: 30 },
  { key: 'dias_31_60', etiqueta: 'Vencida de 31-60', max: 60 },
  { key: 'dias_61_90', etiqueta: 'Vencida de 61-90', max: 90 },
  { key: 'dias_91_120', etiqueta: 'Vencida de 91-120', max: 120 },
  { key: 'dias_121_180', etiqueta: 'Vencida de 121-180', max: 180 },
  { key: 'dias_181_360', etiqueta: 'Vencida de 181-360', max: 360 },
  { key: 'dias_361_720', etiqueta: 'Vencida de 361-720', max: 720 },
  { key: 'dias_720_mas', etiqueta: 'Vencida +720', max: Infinity },
];

/** Classifies an already-overdue document (diasVencido >= 0) into a bucket. */
const clasificarVencido = (diasVencido: number): RangoVencimiento => {
  for (const r of RANGOS) {
    if (diasVencido <= r.max) return r.key;
  }
  return 'dias_720_mas';
};

/**
 * Coproperty-wide aging report: every pending Factura/Nota Débito as of a
 * cut-off date, one row per document (never aggregated per inmueble), each
 * falling into exactly one aging bucket — mirrors a classic AR aging report.
 */
@Injectable()
export class VencimientosCarteraService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
    @InjectModel(SaldoInicial.name)
    private readonly saldosIniciales: Model<SaldoInicialDocument>,
  ) {}

  async findAll(
    query: ConsultarVencimientosCarteraDto,
  ): Promise<RespuestaVencimientosCartera> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    // `fecha` stays the raw calendar day — `calcularDiasMora` and the
    // sinVencer/vencido split below truncate it with LOCAL `setHours`, so
    // it must still fall on the picked calendar day once truncated.
    // `fechaCorte` is the Colombia-local end-of-day INSTANT, used only to
    // decide whether a Recibo/aplicación counts as already active (see
    // `finDelDiaCorte`) — passing the extended value into `calcularDiasMora`
    // would shift every dias-mora count by a full day.
    const fecha = query.fecha ? new Date(query.fecha) : new Date();
    const fechaCorte = query.fecha
      ? finDelDiaCorte(new Date(query.fecha))
      : fecha;

    const [facturas, notasDebito, saldosIniciales] = await Promise.all([
      this.facturas
        .find({ coPropertyId, status: 'emitida', issueDate: { $lte: fecha } })
        .exec(),
      this.notasDebito
        .find({ coPropertyId, status: 'emitida', issueDate: { $lte: fecha } })
        .exec(),
      this.saldosIniciales
        .find({ coPropertyId, status: 'activo', fecha: { $lte: fecha } })
        .exec(),
    ]);

    const docIds = [
      ...facturas.map((f) => f._id),
      ...notasDebito.map((nd) => nd._id),
      ...saldosIniciales.map((s) => s._id),
    ];
    const aplicaciones = docIds.length
      ? await this.aplicaciones
          .find({ coPropertyId, documentId: { $in: docIds } })
          .exec()
      : [];

    const appsByDoc = new Map<string, typeof aplicaciones>();
    for (const app of aplicaciones) {
      const key = app.documentId.toString();
      const list = appsByDoc.get(key) ?? [];
      list.push(app);
      appsByDoc.set(key, list);
    }

    type FilaRaw = {
      inmuebleId: Types.ObjectId;
      /** A Saldo Inicial row carries its own original code (e.g. "FV",
       *  "ND") here instead of the literal "SI" — see
       *  `SaldoInicial.tipoDocumentoOriginal`'s own schema docblock. */
      tipo: 'FV' | 'ND' | 'SI' | (string & {});
      numeroCompleto: string;
      fecha: Date;
      vence: Date;
      saldo: number;
    };

    const filasRaw: FilaRaw[] = [];

    for (const f of facturas) {
      const apps = appsByDoc.get(f._id.toString()) ?? [];
      const aplicadoActivo = apps
        .filter((a) => activeAsOf(a, fechaCorte))
        .reduce((sum, a) => sum + a.amountApplied, 0);
      const saldo = Math.max(0, f.total - aplicadoActivo);
      if (saldo <= 0) continue;

      filasRaw.push({
        inmuebleId: f.inmuebleId,
        tipo: 'FV',
        numeroCompleto: f.fullNumber,
        fecha: f.issueDate,
        vence: f.dueDate,
        saldo,
      });
    }

    for (const nd of notasDebito) {
      const apps = appsByDoc.get(nd._id.toString()) ?? [];
      const aplicadoActivo = apps
        .filter((a) => activeAsOf(a, fechaCorte))
        .reduce((sum, a) => sum + a.amountApplied, 0);
      const saldo = Math.max(0, nd.total - aplicadoActivo);
      if (saldo <= 0) continue;

      // A debit note carries no separate due date — it is due the moment
      // it is issued.
      filasRaw.push({
        inmuebleId: nd.inmuebleId,
        tipo: 'ND',
        numeroCompleto: nd.fullNumber,
        fecha: nd.issueDate,
        vence: nd.issueDate,
        saldo,
      });
    }

    for (const si of saldosIniciales) {
      const apps = appsByDoc.get(si._id.toString()) ?? [];
      const aplicadoActivo = apps
        .filter((a) => activeAsOf(a, fechaCorte))
        .reduce((sum, a) => sum + a.amountApplied, 0);
      const saldo = Math.max(0, si.total - aplicadoActivo);
      if (saldo <= 0) continue;

      filasRaw.push({
        inmuebleId: si.inmuebleId,
        tipo: si.tipoDocumentoOriginal,
        numeroCompleto: si.numeroOriginal,
        fecha: si.fecha,
        vence: si.fechaVencimiento,
        saldo,
      });
    }

    if (filasRaw.length === 0) return empty(fecha);

    const inmuebleData = await this.resolveInmuebles(
      coPropertyId,
      filasRaw.map((r) => r.inmuebleId),
    );

    const rangoTotales = new Map<RangoVencimiento, number>();
    const filas: FilaVencimientoCartera[] = filasRaw.map((r) => {
      const noVencidoAun = r.vence > fecha;
      const diasMora = calcularDiasMora(r.vence, fecha);
      const rango: RangoVencimiento = noVencidoAun
        ? 'sinVencer'
        : clasificarVencido(diasMora);
      rangoTotales.set(rango, (rangoTotales.get(rango) ?? 0) + r.saldo);

      const data = inmuebleData.get(r.inmuebleId.toString());
      return {
        inmuebleId: r.inmuebleId.toString(),
        inmuebleCodigo: data?.codigo ?? '',
        propietario: data?.propietario ?? null,
        tipo: r.tipo,
        numeroCompleto: r.numeroCompleto,
        fecha: r.fecha.toISOString(),
        vence: r.vence.toISOString(),
        diasMora,
        saldo: r.saldo,
        rango,
      };
    });

    filas.sort((a, b) => {
      const porCodigo = a.inmuebleCodigo.localeCompare(b.inmuebleCodigo, 'es', {
        numeric: true,
      });
      if (porCodigo !== 0) return porCodigo;
      return new Date(a.fecha).getTime() - new Date(b.fecha).getTime();
    });

    const rangos: RangoVencimientoCartera[] = [
      {
        rango: 'sinVencer',
        etiqueta: 'Sin Vencer',
        valor: rangoTotales.get('sinVencer') ?? 0,
      },
      ...RANGOS.map((r) => ({
        rango: r.key,
        etiqueta: r.etiqueta,
        valor: rangoTotales.get(r.key) ?? 0,
      })),
    ];

    const totalCartera = filas.reduce((sum, f) => sum + f.saldo, 0);

    return {
      fechaCorte: fecha.toISOString(),
      filas,
      rangos,
      totalCartera,
    };
  }

  /** Batch-fetch inmueble codes and tercero names for the units involved. */
  private async resolveInmuebles(
    coPropertyId: Types.ObjectId,
    inmuebleIds: Types.ObjectId[],
  ): Promise<Map<string, { codigo: string; propietario: string | null }>> {
    const uniqueIds = [...new Set(inmuebleIds.map((id) => id.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const inmuebles = await this.inmuebles
      .find({ coPropertyId, _id: { $in: uniqueIds } })
      .exec();

    const holderIds = inmuebles
      .map((i) => i.holderId)
      .filter((id): id is Types.ObjectId => id !== null);

    const nombreMap = new Map<string, string>();
    if (holderIds.length > 0) {
      const uniqueHolderIds = [
        ...new Set(holderIds.map((id) => id.toString())),
      ];
      const terceros = await this.terceros
        .find({
          coPropertyId,
          _id: { $in: uniqueHolderIds.map((id) => new Types.ObjectId(id)) },
        })
        .exec();
      for (const t of terceros) {
        nombreMap.set(t._id.toString(), t.name);
      }
    }

    const result = new Map<
      string,
      { codigo: string; propietario: string | null }
    >();
    for (const i of inmuebles) {
      result.set(i._id.toString(), {
        codigo: i.code,
        propietario: i.holderId
          ? (nombreMap.get(i.holderId.toString()) ?? null)
          : null,
      });
    }
    return result;
  }
}

function empty(fecha: Date): RespuestaVencimientosCartera {
  return {
    fechaCorte: fecha.toISOString(),
    filas: [],
    rangos: [
      { rango: 'sinVencer', etiqueta: 'Sin Vencer', valor: 0 },
      ...RANGOS.map((r) => ({ rango: r.key, etiqueta: r.etiqueta, valor: 0 })),
    ],
    totalCartera: 0,
  };
}
