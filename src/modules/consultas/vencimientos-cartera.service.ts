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
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
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
import { calcularDocumentosConSaldoAFecha } from './cartera-historica.util';
import type {
  FilaVencimientos,
  RespuestaVencimientosCartera,
} from '../../contracts';
import type { ConsultarVencimientosCarteraDto } from './dto/consultar-vencimientos-cartera.dto';

/** Compute days overdue: max(0, floor((corte - referenceDate) / day)). */
const calcularDiasMora = (fechaReferencia: Date, corte?: Date): number => {
  const c = corte ?? new Date();
  c.setHours(0, 0, 0, 0);
  const ref = new Date(fechaReferencia);
  ref.setHours(0, 0, 0, 0);
  const diff = c.getTime() - ref.getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
};

/**
 * Read-only snapshot report: outstanding balance and days overdue
 * across ALL inmuebles in a coproperty. Supports two modes:
 *  - "as of now" (fecha omitted): reads `outstandingBalance` directly
 *  - "historical" (fecha present): uses the shared `cartera-historica.util`
 *    to reconstruct balances as of the given date
 */
@Injectable()
export class VencimientosCarteraService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldosCartera: Model<SaldoCarteraDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ConsultarVencimientosCarteraDto,
  ): Promise<RespuestaVencimientosCartera> {
    const coPropertyId = this.tenant.resolveCoPropertyId();

    if (query.fecha) {
      return this.findByFecha(coPropertyId, query.fecha, query.conceptoId);
    }

    if (query.conceptoId) {
      return this.findByConcepto(coPropertyId, query.conceptoId);
    }
    return this.findByAllConcepts(coPropertyId);
  }

  /* ── "As of now" path (unchanged from §3/§4/§5) ─────────────── */

  /** No concept filter: read outstandingBalance directly from Factura + ND. */
  private async findByAllConcepts(
    coPropertyId: Types.ObjectId,
  ): Promise<RespuestaVencimientosCartera> {
    const [facturas, notasDebito] = await Promise.all([
      this.facturas
        .find({
          coPropertyId,
          status: 'emitida',
          outstandingBalance: { $gt: 0 },
        })
        .exec(),
      this.notasDebito
        .find({
          coPropertyId,
          status: 'emitida',
          outstandingBalance: { $gt: 0 },
        })
        .exec(),
    ]);

    const saldoMap = new Map<string, number>();
    const diasMoraMap = new Map<string, number>();

    for (const f of facturas) {
      const key = f.inmuebleId.toString();
      saldoMap.set(key, (saldoMap.get(key) ?? 0) + f.outstandingBalance);
      const dm = calcularDiasMora(f.dueDate);
      diasMoraMap.set(key, Math.max(diasMoraMap.get(key) ?? 0, dm));
    }

    for (const nd of notasDebito) {
      const key = nd.inmuebleId.toString();
      saldoMap.set(key, (saldoMap.get(key) ?? 0) + nd.outstandingBalance);
      const dm = calcularDiasMora(nd.issueDate);
      diasMoraMap.set(key, Math.max(diasMoraMap.get(key) ?? 0, dm));
    }

    if (saldoMap.size === 0) return empty();

    const inmuebleIds = [...saldoMap.keys()].map(
      (id) => new Types.ObjectId(id),
    );
    const inmuebleData = await this.resolveInmuebles(coPropertyId, inmuebleIds);

    return this.buildResult(saldoMap, diasMoraMap, inmuebleData);
  }

  /** With concept filter: saldo from SaldoCartera, diasMora from matching docs. */
  private async findByConcepto(
    coPropertyId: Types.ObjectId,
    conceptoId: string,
  ): Promise<RespuestaVencimientosCartera> {
    const conceptoObjectId = new Types.ObjectId(conceptoId);

    const [saldos, facturas, notasDebito] = await Promise.all([
      this.saldosCartera
        .find({
          coPropertyId,
          conceptoId: conceptoObjectId,
          balance: { $gt: 0 },
        })
        .exec(),
      this.facturas
        .find({
          coPropertyId,
          status: 'emitida',
          outstandingBalance: { $gt: 0 },
          'lines.conceptoId': conceptoObjectId,
        })
        .exec(),
      this.notasDebito
        .find({
          coPropertyId,
          status: 'emitida',
          outstandingBalance: { $gt: 0 },
          conceptoId: conceptoObjectId,
        })
        .exec(),
    ]);

    const saldoMap = new Map<string, number>();
    for (const sc of saldos) {
      saldoMap.set(sc.inmuebleId.toString(), sc.balance);
    }

    const diasMoraMap = new Map<string, number>();
    for (const f of facturas) {
      const key = f.inmuebleId.toString();
      const dm = calcularDiasMora(f.dueDate);
      diasMoraMap.set(key, Math.max(diasMoraMap.get(key) ?? 0, dm));
    }
    for (const nd of notasDebito) {
      const key = nd.inmuebleId.toString();
      const dm = calcularDiasMora(nd.issueDate);
      diasMoraMap.set(key, Math.max(diasMoraMap.get(key) ?? 0, dm));
    }

    if (saldoMap.size === 0) return empty();

    const inmuebleIds = [...saldoMap.keys()].map(
      (id) => new Types.ObjectId(id),
    );
    const inmuebleData = await this.resolveInmuebles(coPropertyId, inmuebleIds);

    return this.buildResult(saldoMap, diasMoraMap, inmuebleData);
  }

  /* ── Historical path (§8 — fecha present, uses shared utility) ── */

  /**
   * Reconstruct balances as of `fechaCorte` using the shared
   * `cartera-historica.util`, then group by inmuebleId and compute diasMora.
   */
  private async findByFecha(
    coPropertyId: Types.ObjectId,
    fechaCorte: string,
    conceptoId?: string,
  ): Promise<RespuestaVencimientosCartera> {
    const fecha = new Date(fechaCorte);

    const documentos = await calcularDocumentosConSaldoAFecha(
      {
        facturas: this.facturas,
        notasDebito: this.notasDebito,
        aplicaciones: this.aplicaciones,
      },
      coPropertyId,
      fecha,
      conceptoId ? { conceptoId: new Types.ObjectId(conceptoId) } : undefined,
    );

    // Group by inmuebleId: saldo = sum of montoPendiente, diasMora = worst
    const saldoMap = new Map<string, number>();
    const diasMoraMap = new Map<string, number>();

    for (const doc of documentos) {
      const key = doc.inmuebleId.toString();
      saldoMap.set(key, (saldoMap.get(key) ?? 0) + doc.montoPendiente);
      const dm = calcularDiasMora(doc.fechaReferencia, fecha);
      diasMoraMap.set(key, Math.max(diasMoraMap.get(key) ?? 0, dm));
    }

    if (saldoMap.size === 0) return empty();

    const inmuebleIds = [...saldoMap.keys()].map(
      (id) => new Types.ObjectId(id),
    );
    const inmuebleData = await this.resolveInmuebles(coPropertyId, inmuebleIds);

    return this.buildResult(saldoMap, diasMoraMap, inmuebleData);
  }

  /* ── Shared helpers ──────────────────────────────────────────── */

  /** Batch-fetch inmueble codes and tercero names for the units that have debt. */
  private async resolveInmuebles(
    coPropertyId: Types.ObjectId,
    inmuebleIds: Types.ObjectId[],
  ): Promise<Map<string, { codigo: string; propietario: string | null }>> {
    const inmuebles = await this.inmuebles
      .find({ coPropertyId, _id: { $in: inmuebleIds } })
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
          _id: {
            $in: uniqueHolderIds.map((id) => new Types.ObjectId(id)),
          },
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

  /** Build the final sorted response from aggregated maps. */
  private buildResult(
    saldoMap: Map<string, number>,
    diasMoraMap: Map<string, number>,
    inmuebleData: Map<string, { codigo: string; propietario: string | null }>,
  ): RespuestaVencimientosCartera {
    const filas: FilaVencimientos[] = [...saldoMap.entries()].map(
      ([inmuebleId, saldoPendiente]) => {
        const dm = diasMoraMap.get(inmuebleId) ?? 0;
        const data = inmuebleData.get(inmuebleId);
        return {
          inmuebleId,
          inmuebleCodigo: data?.codigo ?? '',
          propietario: data?.propietario ?? null,
          saldoPendiente,
          diasMora: dm,
          estado: dm > 0 ? ('vencido' as const) : ('pendiente' as const),
        };
      },
    );

    filas.sort((a, b) => b.diasMora - a.diasMora);

    const totalCartera = filas.reduce((s, f) => s + f.saldoPendiente, 0);
    const totalVencido = filas
      .filter((f) => f.estado === 'vencido')
      .reduce((s, f) => s + f.saldoPendiente, 0);
    const totalPendiente = totalCartera - totalVencido;
    const porcentajeVencido =
      totalCartera > 0 ? (totalVencido / totalCartera) * 100 : 0;

    return {
      filas,
      totalCartera,
      totalVencido,
      totalPendiente,
      porcentajeVencido,
    };
  }
}

function empty(): RespuestaVencimientosCartera {
  return {
    filas: [],
    totalCartera: 0,
    totalVencido: 0,
    totalPendiente: 0,
    porcentajeVencido: 0,
  };
}
