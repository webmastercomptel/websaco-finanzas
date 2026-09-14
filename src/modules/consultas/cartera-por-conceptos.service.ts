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
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  activeAsOf,
  finDelDiaCorte,
  limiteEmisionParaCorte,
} from './cartera-historica.util';
import type {
  DocumentoCarteraPorConceptos,
  GrupoInmuebleCarteraPorConceptos,
  RespuestaCarteraPorConceptos,
} from '../../contracts';
import type { ConsultarCarteraPorConceptosDto } from './dto/consultar-cartera-por-conceptos.dto';

/** Internal working shape — carries the raw document number so each
 *  inmueble's documents can be sorted ascending before it is dropped from
 *  the public contract (the API already returns them pre-sorted). */
type DocumentoInterno = DocumentoCarteraPorConceptos & { numero: number };

/**
 * Coproperty-wide pending-documents report, grouped by inmueble and broken
 * down per concepto de cobro — one row per outstanding Factura/Nota Débito,
 * one column per concept. Sibling to Cartera por Inmueble (same
 * per-document/per-concepto shape, same historical-cutoff rules — see that
 * service's own docblock for why a query strictly before today falls back
 * to the proportional split of each document's frozen lines instead of the
 * live `CarteraPorDocumento` ledger), scoped to every inmueble at once
 * instead of one at a time.
 */
@Injectable()
export class CarteraPorConceptosService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(NotaDebito.name)
    private readonly notasDebito: Model<NotaDebitoDocument>,
    @InjectModel(AplicacionCartera.name)
    private readonly aplicaciones: Model<AplicacionCarteraDocument>,
    @InjectModel(ConceptoCobro.name)
    private readonly conceptosCobro: Model<ConceptoCobroDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  async findAll(
    query: ConsultarCarteraPorConceptosDto,
  ): Promise<RespuestaCarteraPorConceptos> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const fecha = query.fecha
      ? finDelDiaCorte(new Date(query.fecha))
      : new Date();
    // Same rule as Cartera por Inmueble: only a cutoff of "now" (including
    // no `fecha` at all) can trust the live per-document ledgers — they
    // carry no point-in-time history. See this class's own docblock.
    const esConsultaVigente =
      !query.fecha || fecha.getTime() >= finDelDiaCorte(new Date()).getTime();

    const conceptos = await this.conceptosCobro
      .find({ coPropertyId })
      .sort({ sortOrder: 1 })
      .exec();
    const conceptosContract = conceptos.map((c) => ({
      conceptoId: c._id.toString(),
      nombre: c.name,
    }));

    const limiteEmision = limiteEmisionParaCorte(fecha);
    const [facturas, notasDebito] = await Promise.all([
      this.facturas
        .find({
          coPropertyId,
          status: 'emitida',
          issueDate: { $lte: limiteEmision },
        })
        .exec(),
      this.notasDebito
        .find({
          coPropertyId,
          status: 'emitida',
          issueDate: { $lte: limiteEmision },
        })
        .exec(),
    ]);

    const docIds = [
      ...facturas.map((f) => f._id),
      ...notasDebito.map((nd) => nd._id),
    ];
    if (docIds.length === 0) {
      return { conceptos: conceptosContract, grupos: [] };
    }

    const [aplicaciones, carteraPorDocumentoRows, saldoTotalRows, inmuebles] =
      await Promise.all([
        this.aplicaciones
          .find({ coPropertyId, documentId: { $in: docIds } })
          .exec(),
        esConsultaVigente
          ? this.carteraPorDocumento
              .find({ coPropertyId, documentoId: { $in: docIds } })
              .exec()
          : Promise.resolve([]),
        esConsultaVigente
          ? this.saldoTotalDocumento
              .find({ documentoId: { $in: docIds } })
              .exec()
          : Promise.resolve([]),
        this.inmuebles.find({ coPropertyId }).exec(),
      ]);

    const appsByDoc = new Map<string, typeof aplicaciones>();
    for (const app of aplicaciones) {
      const key = app.documentId.toString();
      const list = appsByDoc.get(key) ?? [];
      list.push(app);
      appsByDoc.set(key, list);
    }

    // documentoId -> conceptoId -> saldoPendiente, live ledger — only
    // trusted for a "right now" query (see the class docblock).
    const carteraDocById = new Map<string, Map<string, number>>();
    for (const row of carteraPorDocumentoRows) {
      const docKey = row.documentoId.toString();
      const porConcepto =
        carteraDocById.get(docKey) ?? new Map<string, number>();
      porConcepto.set(row.conceptoId.toString(), row.saldoPendiente);
      carteraDocById.set(docKey, porConcepto);
    }
    const saldoTotalById = new Map(
      saldoTotalRows.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );

    const inmuebleById = new Map(inmuebles.map((i) => [i._id.toString(), i]));
    const holderIds = inmuebles
      .map((i) => i.holderId)
      .filter((id): id is Types.ObjectId => id !== null);
    const tercerosMap = new Map<
      string,
      { name: string; phone: string | null }
    >();
    if (holderIds.length > 0) {
      const uniqueHolderIds = [
        ...new Set(holderIds.map((id) => id.toString())),
      ].map((id) => new Types.ObjectId(id));
      const terceros = await this.terceros
        .find({ coPropertyId, _id: { $in: uniqueHolderIds } })
        .exec();
      for (const t of terceros) {
        tercerosMap.set(t._id.toString(), { name: t.name, phone: t.phone });
      }
    }

    const docsPorInmueble = new Map<string, DocumentoInterno[]>();

    const agregar = (
      inmuebleId: Types.ObjectId,
      documentoId: Types.ObjectId,
      tipo: 'FV' | 'ND',
      numeroCompleto: string,
      numero: number,
      fechaDoc: Date,
      vence: Date | null,
      saldoActivo: number,
      cargosFallback: Record<string, number>,
    ): void => {
      const docKey = documentoId.toString();
      const saldoVivo = saldoTotalById.get(docKey);
      const saldo =
        esConsultaVigente && saldoVivo !== undefined ? saldoVivo : saldoActivo;
      if (saldo <= 0) return;

      const carteraDoc = carteraDocById.get(docKey);
      let cargosPorConcepto: Record<string, number>;
      if (carteraDoc && carteraDoc.size > 0) {
        cargosPorConcepto = {};
        for (const [conceptoId, monto] of carteraDoc) {
          if (monto > 0) cargosPorConcepto[conceptoId] = monto;
        }
      } else {
        cargosPorConcepto = cargosFallback;
      }

      const key = inmuebleId.toString();
      const list = docsPorInmueble.get(key) ?? [];
      list.push({
        documentoId: docKey,
        tipo,
        numeroCompleto,
        numero,
        fecha: fechaDoc.toISOString(),
        vence: vence ? vence.toISOString() : null,
        saldo,
        cargosPorConcepto,
      });
      docsPorInmueble.set(key, list);
    };

    for (const f of facturas) {
      const apps = appsByDoc.get(f._id.toString()) ?? [];
      const saldoActivo = Math.max(
        0,
        f.total -
          apps
            .filter((a) => activeAsOf(a, fecha))
            .reduce((sum, a) => sum + a.amountApplied, 0),
      );
      // Proportional split of the document's own frozen lines — the same
      // fallback Cartera por Inmueble uses for a historical query, or for a
      // document the live ledger never tracked.
      const factor = f.total > 0 ? saldoActivo / f.total : 0;
      const cargosFallback: Record<string, number> = {};
      for (const line of f.lines) {
        const key = line.conceptoId.toString();
        cargosFallback[key] =
          (cargosFallback[key] ?? 0) + line.totalAmount * factor;
      }

      agregar(
        f.inmuebleId,
        f._id,
        'FV',
        f.fullNumber,
        f.number,
        f.issueDate,
        f.dueDate,
        saldoActivo,
        cargosFallback,
      );
    }
    for (const nd of notasDebito) {
      const apps = appsByDoc.get(nd._id.toString()) ?? [];
      const saldoActivo = Math.max(
        0,
        nd.total -
          apps
            .filter((a) => activeAsOf(a, fecha))
            .reduce((sum, a) => sum + a.amountApplied, 0),
      );
      agregar(
        nd.inmuebleId,
        nd._id,
        'ND',
        nd.fullNumber,
        nd.number,
        nd.issueDate,
        null,
        saldoActivo,
        { [nd.conceptoId.toString()]: saldoActivo },
      );
    }

    const grupos: GrupoInmuebleCarteraPorConceptos[] = [];
    for (const [inmuebleId, documentosInternos] of docsPorInmueble) {
      documentosInternos.sort((a, b) => a.numero - b.numero);
      const documentos = documentosInternos.map(
        ({ numero: _numero, ...doc }) => doc,
      );

      const inmueble = inmuebleById.get(inmuebleId);
      const holder = inmueble?.holderId
        ? tercerosMap.get(inmueble.holderId.toString())
        : undefined;

      grupos.push({
        inmuebleId,
        inmuebleCodigo: inmueble?.code ?? '',
        titular: holder?.name ?? null,
        celular: holder?.phone ?? null,
        documentos,
        saldoTotal: documentos.reduce((sum, d) => sum + d.saldo, 0),
      });
    }
    grupos.sort((a, b) =>
      a.inmuebleCodigo.localeCompare(b.inmuebleCodigo, 'es', {
        numeric: true,
      }),
    );

    return { conceptos: conceptosContract, grupos };
  }
}
