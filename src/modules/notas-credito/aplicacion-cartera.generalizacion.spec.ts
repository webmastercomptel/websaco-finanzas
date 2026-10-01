import mongoose, { Types } from 'mongoose';
import {
  AplicacionCarteraDocument,
  AplicacionCarteraSchema,
} from '../../database/schemas/recibos/aplicacion-cartera.schema';

const AplicacionModel = mongoose.model<AplicacionCarteraDocument>(
  'AplicacionCarteraGeneralizacionSpec',
  AplicacionCarteraSchema,
);

/** Mongo-equivalent predicate filter over a plain array — this repo mocks
 *  Mongoose everywhere else the same way (hand-rolled stubs, no real
 *  connection), so this is the one place a "query" needs to run for real:
 *  proving the schema's OWN declared shape discriminates and combines
 *  correctly, independent of any one service's mocked model. */
const filtrar = (
  filas: AplicacionCarteraDocument[],
  criterio: Record<string, unknown>,
) =>
  filas.filter((fila) =>
    Object.entries(criterio).every(([clave, valor]) => {
      const actual = (fila as unknown as Record<string, unknown>)[clave];
      return actual instanceof Types.ObjectId && valor instanceof Types.ObjectId
        ? actual.equals(valor)
        : actual === valor;
    }),
  );

describe('AplicacionCartera — generalización RC/NC lado a lado (design §9)', () => {
  const copropiedad = new Types.ObjectId();
  const facturaCompartida = new Types.ObjectId();
  const recibo = new Types.ObjectId();
  const notaCredito = new Types.ObjectId();
  const cuenta = new Types.ObjectId();

  const filaDeRecibo = new AplicacionModel({
    copropiedadId: copropiedad,
    sourceType: 'RC',
    sourceId: recibo,
    tipoDocumento: 'FV',
    documentoId: facturaCompartida,
    montoAplicado: 120000,
    aplicadoEn: new Date('2026-08-27'),
    fechaOrigen: new Date('2026-08-27'),
    aplicadoPor: cuenta,
  });

  const filaDeNotaCredito = new AplicacionModel({
    copropiedadId: copropiedad,
    sourceType: 'NC',
    sourceId: notaCredito,
    tipoDocumento: 'FV',
    documentoId: facturaCompartida,
    montoAplicado: 80000,
    aplicadoEn: new Date('2026-08-30'),
    fechaOrigen: new Date('2026-08-30'),
    aplicadoPor: cuenta,
  });

  const coleccion = [filaDeRecibo, filaDeNotaCredito];

  it('ambas filas validan contra el mismo schema, sin ningún campo Recibo-específico sobrante', async () => {
    await expect(filaDeRecibo.validate()).resolves.toBeUndefined();
    await expect(filaDeNotaCredito.validate()).resolves.toBeUndefined();
  });

  it('el índice {sourceType, sourceId} aísla la aplicación del Recibo de la de la Nota Crédito', () => {
    const soloRecibo = filtrar(coleccion, {
      sourceType: 'RC',
      sourceId: recibo,
    });
    expect(soloRecibo).toEqual([filaDeRecibo]);

    const soloNotaCredito = filtrar(coleccion, {
      sourceType: 'NC',
      sourceId: notaCredito,
    });
    expect(soloNotaCredito).toEqual([filaDeNotaCredito]);
  });

  it('el índice {tipoDocumento, documentoId} devuelve AMBAS filas juntas — la consulta que habilita la futura pantalla de Confirmación y Cruce', () => {
    const contraLaMismaFactura = filtrar(coleccion, {
      tipoDocumento: 'FV',
      documentoId: facturaCompartida,
    });

    expect(contraLaMismaFactura).toHaveLength(2);
    expect(contraLaMismaFactura).toEqual(
      expect.arrayContaining([filaDeRecibo, filaDeNotaCredito]),
    );
  });

  it('nunca cruza sourceId entre tipos: un sourceId de Recibo no matchea contra sourceType NC', () => {
    const cruzado = filtrar(coleccion, { sourceType: 'NC', sourceId: recibo });
    expect(cruzado).toEqual([]);
  });
});
