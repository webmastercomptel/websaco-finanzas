import mongoose, { Types } from 'mongoose';
import { AplicacionCarteraSchema } from '../../database/schemas/recibos/aplicacion-cartera.schema';

const AplicacionModel = mongoose.model(
  'AplicacionCarteraGeneralizacionSpec',
  AplicacionCarteraSchema,
);

/** Mongo-equivalent predicate filter over a plain array — this repo mocks
 *  Mongoose everywhere else the same way (hand-rolled stubs, no real
 *  connection), so this is the one place a "query" needs to run for real:
 *  proving the schema's OWN declared shape discriminates and combines
 *  correctly, independent of any one service's mocked model. */
const filtrar = (
  filas: (typeof AplicacionModel.prototype)[],
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
    coPropertyId: copropiedad,
    sourceType: 'RC',
    sourceId: recibo,
    documentType: 'FV',
    documentId: facturaCompartida,
    amountApplied: 120000,
    appliedAt: new Date('2026-08-27'),
    appliedBy: cuenta,
  });

  const filaDeNotaCredito = new AplicacionModel({
    coPropertyId: copropiedad,
    sourceType: 'NC',
    sourceId: notaCredito,
    documentType: 'FV',
    documentId: facturaCompartida,
    amountApplied: 80000,
    appliedAt: new Date('2026-08-30'),
    appliedBy: cuenta,
  });

  const coleccion = [filaDeRecibo, filaDeNotaCredito];

  it('ambas filas validan contra el mismo schema, sin ningún campo Recibo-específico sobrante', async () => {
    await expect(filaDeRecibo.validate()).resolves.toBeUndefined();
    await expect(filaDeNotaCredito.validate()).resolves.toBeUndefined();
  });

  it('el índice {sourceType, sourceId} aísla la aplicación del Recibo de la de la Nota Crédito', () => {
    const soloRecibo = filtrar(coleccion, { sourceType: 'RC', sourceId: recibo });
    expect(soloRecibo).toEqual([filaDeRecibo]);

    const soloNotaCredito = filtrar(coleccion, { sourceType: 'NC', sourceId: notaCredito });
    expect(soloNotaCredito).toEqual([filaDeNotaCredito]);
  });

  it('el índice {documentType, documentId} devuelve AMBAS filas juntas — la consulta que habilita la futura pantalla de Confirmación y Cruce', () => {
    const contraLaMismaFactura = filtrar(coleccion, {
      documentType: 'FV',
      documentId: facturaCompartida,
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
