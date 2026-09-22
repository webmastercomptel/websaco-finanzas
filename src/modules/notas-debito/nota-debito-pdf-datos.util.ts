import type { Model, Types } from 'mongoose';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';
import type { AsientoContableDocument } from '../../database/schemas/facturacion/asiento-contable.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';
import type {
  DatosReciboImpresion,
  LineaAsientoImpresion,
} from '../../common/documentos/datos-impresion.types';

export interface ModelosDatosImpresionNotaDebito {
  inmuebles: Model<InmuebleDocument>;
  terceros: Model<TerceroDocument>;
  conceptos: Model<ConceptoCobroDocument>;
  asientos: Model<AsientoContableDocument>;
  cuentasContables: Model<CuentaContableDocument>;
}

/**
 * Assembles everything the Nota Débito PDF needs to draw its journal-entry
 * table — same shape and same drawing code as a Recibo/Nota Crédito's own
 * print (`contenidoRecibo`, `recibo-pdf.ts`; `tituloDocumento` is what
 * tells the renderer which one this is). Replaces the old
 * `generarPdfNotaDebito` (a bare label/value listing, no journal table).
 *
 * Unlike Nota Crédito's own builder — which recomputes its lines from
 * facturas/aplicaciones because it needs per-document references
 * (`tipoDocumento`/`numeroDocumento`) a Nota Débito's entries never carry —
 * this one reads the journal entries STRAIGHT OFF the persisted
 * `AsientoContable` (`notaDebitoId: nota._id`) instead of re-deriving the
 * débito/crédito accounts from the concepto: `NotasDebitoService.crear()`
 * already resolved `cuentaDebitoId`/`cuentaCreditoId` (with the
 * cuentas-de-orden override for an intereses concepto, see
 * `construirMovimientos`) at posting time, so reading that back is the only
 * way this print can never drift from what was actually coded — no second
 * copy of that branching to keep in sync.
 */
export async function construirDatosImpresionNotaDebito(
  nota: NotaDebitoDocument,
  copropiedad: CopropiedadDocument,
  coPropertyId: Types.ObjectId,
  modelos: ModelosDatosImpresionNotaDebito,
): Promise<DatosReciboImpresion> {
  const [inmueble, tercero, concepto, asiento] = await Promise.all([
    modelos.inmuebles.findOne({ _id: nota.inmuebleId, coPropertyId }).exec(),
    nota.terceroId
      ? modelos.terceros.findOne({ _id: nota.terceroId, coPropertyId }).exec()
      : Promise.resolve(null),
    modelos.conceptos.findOne({ _id: nota.conceptoId, coPropertyId }).exec(),
    modelos.asientos.findOne({ coPropertyId, notaDebitoId: nota._id }).exec(),
  ]);

  const movimientos = asiento?.entries ?? [];
  const codigosUsados = new Set(movimientos.map((m) => m.account));
  const cuentas = await modelos.cuentasContables
    .find({ coPropertyId, code: { $in: [...codigosUsados] } })
    .exec();
  const nombrePorCodigo = new Map(cuentas.map((c) => [c.code, c.name]));

  // Sin referencia a ningún documento puntual (ni facturas ni recibos) —
  // el mismo `null`/`null` que ya usa la línea de banco/anticipo de un
  // Recibo para lo que no liquida un documento específico.
  const lineas: LineaAsientoImpresion[] = movimientos.map((m) => ({
    cuentaCodigo: m.account,
    cuentaNombre: nombrePorCodigo.get(m.account) ?? m.account,
    tipoDocumento: null,
    numeroDocumento: null,
    debito: m.type === 'debito' ? m.amount : 0,
    credito: m.type === 'credito' ? m.amount : 0,
  }));

  return {
    tituloDocumento: 'Nota de Débito',
    numeroCompleto: nota.fullNumber,
    fecha: nota.issueDate,
    inmuebleCodigo: inmueble?.code ?? '—',
    titularNombre: tercero?.name ?? '—',
    concepto: nota.description ?? concepto?.name ?? 'Cargo manual',
    monto: nota.total,
    lineas,
  };
}
