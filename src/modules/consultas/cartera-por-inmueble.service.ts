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
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
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
 * The per-document `cargosPorConcepto` (each Factura/Nota Débito's own row),
 * for a "right now" query, is read from `CarteraPorDocumento` — the live
 * per-document ledger a Nota Contable reclassification actually moves (see
 * that schema's own docblock). The underlying Factura/NotaDebito documents
 * stay frozen forever, same as always — only their SEPARATE cartera ledger
 * row moves. A HISTORICAL query (`fecha` strictly before today) instead
 * falls back to the old proportional split of each document's own frozen
 * lines: `CarteraPorDocumento` only tracks the CURRENT state, not a
 * point-in-time history, so it cannot answer "what did this document owe,
 * per concepto, as of last month" — same limitation `cartera-historica.util.ts`
 * already documents for the aggregate side. The AGGREGATE `cargosPorConcepto`
 * (the per-inmueble totals row) is a different question: it PREFERS
 * `SaldoCartera` over summing those same frozen lines, so a Nota Contable
 * reclassification between two conceptos (e.g. moving 100 from "TV" to
 * "Pintura") shows up there too — TV drops, Pintura rises, the inmueble's
 * grand total is unchanged.
 *
 * "Prefers", not "always": a concepto `SaldoCartera` never tracked for this
 * inmueble at all (a Factura loaded by a path that predates or bypasses its
 * maintenance — a historical data import is the real case this guards) falls
 * back to the document-derived total instead of printing a false 0 — see
 * the aggregate row's own comment for exactly how presence, not value,
 * decides the fallback.
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
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
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

    // `CarteraPorDocumento` only tracks the CURRENT state — it has no
    // point-in-time history. A cutoff strictly before today asks "what did
    // this document owe back then", which the live ledger cannot answer, so
    // that case falls back to the old proportional-split-of-frozen-lines
    // computation below. A cutoff of today (the common case, including
    // every caller that omits `fecha` entirely) is answered by the ledger.
    const esConsultaVigente =
      !query.fecha || fecha.getTime() >= finDelDiaCorte(new Date()).getTime();

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

    // The live per-document ledger — only fetched (and only trusted) for a
    // "right now" query. `carteraDocById` maps documentoId -> conceptoId ->
    // saldoPendiente, empty per document with no rows there yet (a document
    // predating this ledger, or a genuinely brand-new one this same
    // transaction hasn't reached).
    const carteraPorDocumentoRows =
      esConsultaVigente && docIds.length
        ? await this.carteraPorDocumento
            .find({ coPropertyId, inmuebleId, documentoId: { $in: docIds } })
            .exec()
        : [];
    const carteraDocById = new Map<string, Map<string, number>>();
    for (const row of carteraPorDocumentoRows) {
      const docKey = row.documentoId.toString();
      const porConcepto =
        carteraDocById.get(docKey) ?? new Map<string, number>();
      porConcepto.set(row.conceptoId.toString(), row.saldoPendiente);
      carteraDocById.set(docKey, porConcepto);
    }

    const documentos: DocumentoCarteraPorInmueble[] = [];
    // Fallback source for the aggregate row below — see its own comment on
    // why SaldoCartera alone isn't always trustworthy.
    const totalesDocumentos = new Map<string, number>();

    for (const f of facturas) {
      const apps = appsByDoc.get(f._id.toString()) ?? [];
      const aplicadoActivo = apps
        .filter((a) => activeAsOf(a, fecha))
        .reduce((sum, a) => sum + a.amountApplied, 0);
      const saldo = Math.max(0, f.total - aplicadoActivo);
      if (saldo <= 0) continue;

      const carteraDoc = carteraDocById.get(f._id.toString());
      let cargosDoc: Record<string, number>;
      if (carteraDoc && carteraDoc.size > 0) {
        // Live ledger, already correct per concepto — reflects any Nota
        // Contable reclassification this document was the target of.
        cargosDoc = {};
        for (const [conceptoId, monto] of carteraDoc) {
          if (monto <= 0) continue;
          cargosDoc[conceptoId] = monto;
          totalesDocumentos.set(
            conceptoId,
            (totalesDocumentos.get(conceptoId) ?? 0) + monto,
          );
        }
      } else {
        // Historical query, or a document the ledger never tracked (see
        // this class's own docblock) — split the pending share
        // proportionally across lines by totalAmount, same allocation
        // `SaldoCartera`'s own maintenance uses.
        const factor = f.total > 0 ? saldo / f.total : 0;
        cargosDoc = {};
        for (const line of f.lines) {
          const key = line.conceptoId.toString();
          const monto = line.totalAmount * factor;
          cargosDoc[key] = (cargosDoc[key] ?? 0) + monto;
          totalesDocumentos.set(key, (totalesDocumentos.get(key) ?? 0) + monto);
        }
      }

      documentos.push({
        documentoId: f._id.toString(),
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

      const carteraDoc = carteraDocById.get(nd._id.toString());
      let cargosDoc: Record<string, number>;
      if (carteraDoc && carteraDoc.size > 0) {
        // Live ledger — a Nota Débito can end up with MORE than its own
        // single `conceptoId` here if it was ever the DESTINO of a
        // reclassification into a concepto it never originally charged.
        cargosDoc = {};
        for (const [conceptoId, monto] of carteraDoc) {
          if (monto <= 0) continue;
          cargosDoc[conceptoId] = monto;
          totalesDocumentos.set(
            conceptoId,
            (totalesDocumentos.get(conceptoId) ?? 0) + monto,
          );
        }
      } else {
        const key = nd.conceptoId.toString();
        totalesDocumentos.set(key, (totalesDocumentos.get(key) ?? 0) + saldo);
        cargosDoc = { [key]: saldo };
      }

      documentos.push({
        documentoId: nd._id.toString(),
        tipo: 'ND',
        numeroCompleto: nd.fullNumber,
        fecha: nd.issueDate.toISOString(),
        vence: null,
        saldo,
        cargosPorConcepto: cargosDoc,
      });
    }

    documentos.sort(
      (a, b) => new Date(a.fecha).getTime() - new Date(b.fecha).getTime(),
    );

    const [conceptos, saldos] = await Promise.all([
      this.conceptosCobro.find({ coPropertyId }).sort({ sortOrder: 1 }).exec(),
      this.saldosCartera.find({ coPropertyId, inmuebleId }).exec(),
    ]);
    const saldosPorConcepto = new Map<string, number>();
    for (const s of saldos) {
      saldosPorConcepto.set(s.conceptoId.toString(), s.balance);
    }

    // Prefer SaldoCartera (reflects a Nota Contable reclassification) — but
    // only for a concepto it actually TRACKS for this inmueble. A concepto
    // absent from SaldoCartera entirely (never incremented for it — e.g. a
    // Factura loaded by a path that predates/bypasses SaldoCartera
    // maintenance, such as a historical data import) must fall back to the
    // document-derived total, or it would silently print 0 for a concepto
    // that documents clearly show a real pending amount for. Presence, not
    // value, is what decides the fallback — a concepto legitimately
    // reclassified down to exactly 0 still has a SaldoCartera row and must
    // show 0, not the stale pre-reclassification document total.
    const cargosPorConcepto: CargoCarteraPorConcepto[] = conceptos.map((c) => {
      const id = c._id.toString();
      return {
        conceptoId: id,
        nombre: c.name,
        monto: saldosPorConcepto.has(id)
          ? saldosPorConcepto.get(id)!
          : (totalesDocumentos.get(id) ?? 0),
      };
    });

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
