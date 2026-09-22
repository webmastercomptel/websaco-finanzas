import type { Model, Types } from 'mongoose';
import type { NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';
import { CUENTA_SIN_ASIGNAR } from '../facturacion/asiento.builder';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import type {
  DatosReciboImpresion,
  LineaAsientoImpresion,
} from '../../common/documentos/datos-impresion.types';
import { fechaNotaContable } from './notas-contables.mapper';

export interface ModelosDatosImpresionNotaContable {
  conceptos: Model<ConceptoCobroDocument>;
  inmuebles: Model<InmuebleDocument>;
  terceros: Model<TerceroDocument>;
  cuentasContables: Model<CuentaContableDocument>;
}

/**
 * Assembles what a Nota Contable's PDF needs to draw its journal-entry
 * table — same shape and same drawing code as a Recibo/Nota Crédito print
 * (`contenidoRecibo`, `recibo-pdf.ts`; `tituloDocumento` tells the renderer
 * which one this is). Replaces this document's own former bespoke,
 * unfinished PDF (`nota-contable-pdf.ts`, now unused), which never resolved
 * concept names at all — printing the raw `conceptoOrigenId` ObjectId.
 *
 * Exactly two lines, mirroring `NotasContablesService.postearAsiento`'s own
 * real posting: origen credited, destino debited (design §7 — the cartera
 * view, not the income-statement one; see `construirMovimientosReclasificacion`'s
 * own docblock). Both read each concepto's `cuentaCreditoId` — the same
 * account the real asiento uses — never a generic "reclasificación" account,
 * so the printed document and the ledger always agree on where the money
 * went.
 *
 * A Nota Contable has no `terceroId` of its own (unlike Nota Crédito/Débito)
 * — it reclassifies within one inmueble's cartera, not against a specific
 * party's document — so `titularNombre` is resolved the same way Cartera
 * por Inmueble resolves it: `Inmueble.holderId` -> `Tercero.name`.
 */
export async function construirDatosImpresionNotaContable(
  nota: NotaContableDocument,
  copropiedad: CopropiedadDocument,
  coPropertyId: Types.ObjectId,
  modelos: ModelosDatosImpresionNotaContable,
): Promise<DatosReciboImpresion> {
  const [conceptoOrigen, conceptoDestino, inmueble] = await Promise.all([
    modelos.conceptos
      .findOne({ _id: nota.conceptoOrigenId, coPropertyId })
      .populate('cuentaCreditoId', 'code')
      .exec(),
    modelos.conceptos
      .findOne({ _id: nota.conceptoDestinoId, coPropertyId })
      .populate('cuentaCreditoId', 'code')
      .exec(),
    modelos.inmuebles.findOne({ _id: nota.inmuebleId, coPropertyId }).exec(),
  ]);

  const tercero = inmueble?.holderId
    ? await modelos.terceros
        .findOne({ _id: inmueble.holderId, coPropertyId })
        .exec()
    : null;

  const codigoOrigen =
    codigoDeCuentaContable(conceptoOrigen?.cuentaCreditoId) ??
    CUENTA_SIN_ASIGNAR;
  const codigoDestino =
    codigoDeCuentaContable(conceptoDestino?.cuentaCreditoId) ??
    CUENTA_SIN_ASIGNAR;

  const cuentas = await modelos.cuentasContables
    .find({ coPropertyId, code: { $in: [codigoOrigen, codigoDestino] } })
    .exec();
  const nombrePorCodigo = new Map(cuentas.map((c) => [c.code, c.name]));

  const lineas: LineaAsientoImpresion[] = [
    {
      cuentaCodigo: codigoOrigen,
      cuentaNombre: nombrePorCodigo.get(codigoOrigen) ?? codigoOrigen,
      tipoDocumento: null,
      numeroDocumento: null,
      debito: 0,
      credito: nota.monto,
    },
    {
      cuentaCodigo: codigoDestino,
      cuentaNombre: nombrePorCodigo.get(codigoDestino) ?? codigoDestino,
      tipoDocumento: null,
      numeroDocumento: null,
      debito: nota.monto,
      credito: 0,
    },
  ];

  return {
    tituloDocumento: 'Nota Contable',
    numeroCompleto: nota.fullNumber,
    fecha: fechaNotaContable(nota),
    inmuebleCodigo: inmueble?.code ?? '—',
    titularNombre: tercero?.name ?? '—',
    concepto: nota.description,
    monto: nota.monto,
    lineas,
  };
}
