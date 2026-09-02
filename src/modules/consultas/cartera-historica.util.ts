import { Model, Types } from 'mongoose';
import { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';

/**
 * A document (Factura or NotaDebito) with a positive outstanding balance
 * as of a historical date. Returned by `calcularDocumentosConSaldoAFecha`.
 */
export interface DocumentoConSaldoAFecha {
  inmuebleId: Types.ObjectId;
  tipo: 'FV' | 'ND';
  montoPendiente: number;
  fechaReferencia: Date;
}

/**
 * Determine whether an application was active as of a given date.
 *
 * An application is "active as of `fecha`" if it was applied at or before
 * `fecha` AND either:
 *  - it is still active (`status === 'activa'`), OR
 *  - it was reverted AFTER `fecha` (`status === 'revertida'` AND
 *    `revertedAt > fecha`)
 *
 * The second condition means: at `fecha` the application had already reduced
 * the balance but its reversal had not yet happened.
 */
function activeAsOf(
  app: { status: string; appliedAt: Date; revertedAt: Date | null },
  fecha: Date,
): boolean {
  if (app.appliedAt > fecha) return false;
  if (app.status === 'activa') return true;
  if (app.status === 'revertida' && app.revertedAt && app.revertedAt > fecha)
    return true;
  return false;
}

/**
 * Compute the outstanding balance of a document as of `fecha` given a list
 * of its applications.
 *
 * saldoAtCorte = total − sum(amountApplied of every application that was
 *                active as of `fecha`)
 */
function saldoDocumentoAFecha(
  total: number,
  apps: Array<{
    amountApplied: number;
    appliedAt: Date;
    status: string;
    revertedAt: Date | null;
  }>,
  fecha: Date,
): number {
  let activeAtFecha = 0;
  for (const app of apps) {
    if (activeAsOf(app, fecha)) {
      activeAtFecha += app.amountApplied;
    }
  }
  return Math.max(0, total - activeAtFecha);
}

/**
 * Shared point-in-time utility: returns every Factura and NotaDebito with a
 * positive outstanding balance as of `fecha`, coproperty-wide (or scoped
 * by `opciones`).
 *
 * Used by:
 *  - Vencimientos de Cartera (§8 addendum) for historical aging
 *  - Cartera General (§2) for aggregate KPIs
 *
 * The utility is a pure function taking model references — the same
 * "inject models, return data" shape as `cruce.util.ts`.
 */
export async function calcularDocumentosConSaldoAFecha(
  models: {
    facturas: Model<FacturaDocument>;
    notasDebito: Model<NotaDebitoDocument>;
    aplicaciones: Model<AplicacionCarteraDocument>;
  },
  coPropertyId: Types.ObjectId,
  fecha: Date,
  opciones?: { inmuebleId?: Types.ObjectId; conceptoId?: Types.ObjectId },
): Promise<DocumentoConSaldoAFecha[]> {
  const facturasFilter: Record<string, unknown> = {
    coPropertyId,
    status: 'emitida',
    issueDate: { $lte: fecha },
  };
  const ndFilter: Record<string, unknown> = {
    coPropertyId,
    status: 'emitida',
    issueDate: { $lte: fecha },
  };

  if (opciones?.inmuebleId) {
    facturasFilter.inmuebleId = opciones.inmuebleId;
    ndFilter.inmuebleId = opciones.inmuebleId;
  }
  if (opciones?.conceptoId) {
    facturasFilter['lines.conceptoId'] = opciones.conceptoId;
    ndFilter.conceptoId = opciones.conceptoId;
  }

  const [facturas, notasDebito] = await Promise.all([
    models.facturas.find(facturasFilter).exec(),
    models.notasDebito.find(ndFilter).exec(),
  ]);

  // Collect document IDs to find their applications
  const facturaIds = facturas.map((f) => f._id);
  const ndIds = notasDebito.map((nd) => nd._id);
  const docIds = [...facturaIds, ...ndIds];

  const aplicaciones = docIds.length
    ? await models.aplicaciones
        .find({ coPropertyId, documentId: { $in: docIds } })
        .exec()
    : [];

  // Index applications by documentId
  const appsByDoc = new Map<string, typeof aplicaciones>();
  for (const app of aplicaciones) {
    const key = app.documentId.toString();
    const list = appsByDoc.get(key) ?? [];
    list.push(app);
    appsByDoc.set(key, list);
  }

  const resultado: DocumentoConSaldoAFecha[] = [];

  for (const f of facturas) {
    const docApps = appsByDoc.get(f._id.toString()) ?? [];
    const monto = saldoDocumentoAFecha(f.total, docApps, fecha);
    if (monto > 0) {
      resultado.push({
        inmuebleId: f.inmuebleId,
        tipo: 'FV',
        montoPendiente: monto,
        fechaReferencia: f.dueDate,
      });
    }
  }

  for (const nd of notasDebito) {
    const docApps = appsByDoc.get(nd._id.toString()) ?? [];
    const monto = saldoDocumentoAFecha(nd.total, docApps, fecha);
    if (monto > 0) {
      resultado.push({
        inmuebleId: nd.inmuebleId,
        tipo: 'ND',
        montoPendiente: monto,
        fechaReferencia: nd.issueDate,
      });
    }
  }

  return resultado;
}
