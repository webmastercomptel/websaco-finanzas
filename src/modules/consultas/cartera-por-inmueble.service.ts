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
  AplicacionCartera,
  AplicacionCarteraDocument,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';
import {
  ConceptoCobro,
  ConceptoCobroDocument,
} from '../../database/schemas/conceptos/concepto-cobro.schema';
import {
  SaldoCartera,
  SaldoCarteraDocument,
} from '../../database/schemas/facturacion/saldo-cartera.schema';
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
  CargoCarteraPorConcepto,
  DocumentoCarteraPorInmueble,
  RespuestaCarteraPorInmueble,
} from '../../contracts';
import type { ConsultarCarteraPorInmuebleDto } from './dto/consultar-cartera-por-inmueble.dto';

/**
 * Read-only single-unit snapshot: every pending Factura/Nota Débito for one
 * inmueble as of a cut-off date, plus that outstanding balance broken down by
 * charge concept. Concepts are rows, never columns — see ConceptoCobro's own
 * schema comment on why this codebase replaced the old system's fixed
 * twelve-column design; this report keeps that even though its old-system
 * equivalent used one column per concept.
 *
 * The per-document `cargosPorConcepto` (each Factura/Nota Débito's own row)
 * is, and must stay, a plain read of that document's own frozen lines — a
 * Factura is never modified after issue, full stop. The AGGREGATE
 * `cargosPorConcepto` (the per-inmueble totals row) is a different question:
 * it reads `SaldoCartera` instead of summing those same frozen lines, so a
 * Nota Contable reclassification between two conceptos (e.g. moving 100 from
 * "TV" to "Pintura") shows up there — TV drops, Pintura rises, the inmueble's
 * grand total is unchanged — even though no individual invoice's own row
 * moved even one peso. Before this, the totals row silently re-derived from
 * the same immutable lines as the per-document rows, so a reclassification
 * was invisible everywhere on this screen.
 */
@Injectable()
export class CarteraPorInmuebleService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptosCobro: Model<ConceptoCobroDocument>,
    @InjectModel(SaldoCartera.name)
    private readonly saldosCartera: Model<SaldoCarteraDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findOne(
    query: ConsultarCarteraPorInmuebleDto,
  ): Promise<RespuestaCarteraPorInmueble> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const inmuebleId = new Types.ObjectId(query.inmuebleId);
    // A bare "YYYY-MM-DD" parses as that day's midnight (00:00:00.000Z),
    // which would exclude anything dated that same day with a real
    // timestamp later than midnight (e.g. a Recibo applied this afternoon).
    // Running the cut-off through the end of the day makes "hoy" actually
    // mean "everything up to right now, today" — omitted `fecha` already
    // gets that for free via `new Date()`.
    const fecha = query.fecha
      ? finDelDiaCorte(new Date(query.fecha))
      : new Date();

    const inmueble = await this.inmuebles
      .findOne({ _id: inmuebleId, coPropertyId })
      .exec();
    const inmuebleCodigo = inmueble?.code ?? '';

    let propietario: string | null = null;
    if (inmueble?.holderId) {
      const tercero = await this.terceros
        .findOne({ _id: inmueble.holderId, coPropertyId })
        .exec();
      propietario = tercero?.name ?? null;
    }

    const [facturas, notasDebito] = await Promise.all([
      this.facturas
        .find({
          coPropertyId,
          inmuebleId,
          status: 'emitida',
          issueDate: { $lte: fecha },
        })
        .exec(),
      this.notasDebito
        .find({
          coPropertyId,
          inmuebleId,
          status: 'emitida',
          issueDate: { $lte: fecha },
        })
        .exec(),
    ]);

    const docIds = [
      ...facturas.map((f) => f._id),
      ...notasDebito.map((nd) => nd._id),
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

    const documentos: DocumentoCarteraPorInmueble[] = [];

    for (const f of facturas) {
      const apps = appsByDoc.get(f._id.toString()) ?? [];
      const aplicadoActivo = apps
        .filter((a) => activeAsOf(a, fecha))
        .reduce((sum, a) => sum + a.amountApplied, 0);
      const saldo = Math.max(0, f.total - aplicadoActivo);
      if (saldo <= 0) continue;

      // Split the pending share proportionally across lines by totalAmount
      // — same allocation SaldoCartera's own maintenance uses (see its
      // schema docblock) — so each line's share sums back to `saldo`.
      const factor = f.total > 0 ? saldo / f.total : 0;
      const cargosDoc: Record<string, number> = {};
      for (const line of f.lines) {
        const key = line.conceptoId.toString();
        const monto = line.totalAmount * factor;
        cargosDoc[key] = (cargosDoc[key] ?? 0) + monto;
      }

      documentos.push({
        tipo: 'FV',
        numeroCompleto: f.fullNumber,
        fecha: f.issueDate.toISOString(),
        vence: f.dueDate.toISOString(),
        saldo,
        cargosPorConcepto: cargosDoc,
      });
    }

    for (const nd of notasDebito) {
      const apps = appsByDoc.get(nd._id.toString()) ?? [];
      const aplicadoActivo = apps
        .filter((a) => activeAsOf(a, fecha))
        .reduce((sum, a) => sum + a.amountApplied, 0);
      const saldo = Math.max(0, nd.total - aplicadoActivo);
      if (saldo <= 0) continue;

      const key = nd.conceptoId.toString();

      documentos.push({
        tipo: 'ND',
        numeroCompleto: nd.fullNumber,
        fecha: nd.issueDate.toISOString(),
        vence: null,
        saldo,
        cargosPorConcepto: { [key]: saldo },
      });
    }

    documentos.sort(
      (a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime(),
    );

    const [conceptos, saldos] = await Promise.all([
      this.conceptosCobro.find({ coPropertyId }).sort({ sortOrder: 1 }).exec(),
      this.saldosCartera.find({ coPropertyId, inmuebleId }).exec(),
    ]);
    const conceptoTotales = new Map<string, number>();
    for (const s of saldos) {
      conceptoTotales.set(s.conceptoId.toString(), s.balance);
    }

    const cargosPorConcepto: CargoCarteraPorConcepto[] = conceptos.map((c) => ({
      conceptoId: c._id.toString(),
      nombre: c.name,
      monto: conceptoTotales.get(c._id.toString()) ?? 0,
    }));

    const saldoTotalCartera = documentos.reduce((sum, d) => sum + d.saldo, 0);

    return {
      inmuebleId: query.inmuebleId,
      inmuebleCodigo,
      propietario,
      fechaCorte: fecha.toISOString(),
      documentos,
      cargosPorConcepto,
      saldoTotalCartera,
    };
  }
}
