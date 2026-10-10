import { Types } from 'mongoose';
import {
  documentoCruceDeMovimiento,
  resolverSaldosInicialesPorNumero,
} from './saldo-inicial-cruce.util';

const COP = new Types.ObjectId();

const modeloCon = (docs: Record<string, unknown>[]) => {
  const exec = jest.fn(() => Promise.resolve(docs));
  const session = jest.fn(() => ({ exec }));
  const find = jest.fn(() => ({ exec, session }));
  return { find, session, exec };
};

describe('resolverSaldosInicialesPorNumero', () => {
  it('resuelve el ordinal interno al documento original, acotado a la copropiedad', async () => {
    const modelo = modeloCon([
      { numero: 2, tipoDocumentoOriginal: 'FV', numeroOriginal: '2941' },
    ]);

    const mapa = await resolverSaldosInicialesPorNumero(modelo as never, COP, [
      {
        movimientos: [
          { tipoDocumento: 'SI', numeroDocumento: 2 },
          { tipoDocumento: 'SI', numeroDocumento: 2 },
          { tipoDocumento: 'FV', numeroDocumento: 7 },
          { tipoDocumento: null, numeroDocumento: null },
        ],
      },
    ]);

    expect(modelo.find).toHaveBeenCalledTimes(1);
    expect(modelo.find).toHaveBeenCalledWith(
      { copropiedadId: COP, numero: { $in: [2] } },
      expect.any(Object),
    );
    expect(mapa.get(2)).toEqual({ tipo: 'FV', numero: '2941' });
  });

  it('no consulta nada cuando ningún movimiento es de Saldo Inicial', async () => {
    const modelo = modeloCon([]);
    const mapa = await resolverSaldosInicialesPorNumero(modelo as never, COP, [
      { movimientos: [{ tipoDocumento: 'FV', numeroDocumento: 7 }] },
    ]);
    expect(modelo.find).not.toHaveBeenCalled();
    expect(mapa.size).toBe(0);
  });

  it('usa la sesión cuando se le pasa una', async () => {
    const modelo = modeloCon([]);
    const sesion = {} as never;
    await resolverSaldosInicialesPorNumero(
      modelo as never,
      COP,
      [{ movimientos: [{ tipoDocumento: 'SI', numeroDocumento: 2 }] }],
      sesion,
    );
    expect(modelo.session).toHaveBeenCalledWith(sesion);
  });

  it('sin modelo (mocks posicionales antiguos) devuelve un mapa vacío', async () => {
    const mapa = await resolverSaldosInicialesPorNumero(undefined, COP, [
      { movimientos: [{ tipoDocumento: 'SI', numeroDocumento: 2 }] },
    ]);
    expect(mapa.size).toBe(0);
  });
});

describe('documentoCruceDeMovimiento', () => {
  const mapa = new Map([[2, { tipo: 'FV', numero: '2941' }]]);

  it('un movimiento SI muestra el documento original, nunca SI ni el ordinal', () => {
    expect(
      documentoCruceDeMovimiento(
        { tipoDocumento: 'SI', numeroDocumento: 2 },
        mapa,
      ),
    ).toEqual({ tipo: 'FV', numero: '2941' });
  });

  it('un movimiento FV/ND conserva lo almacenado', () => {
    expect(
      documentoCruceDeMovimiento(
        { tipoDocumento: 'FV', numeroDocumento: 2 },
        mapa,
      ),
    ).toEqual({ tipo: 'FV', numero: 2 });
  });

  it('una línea sin documento cruce devuelve null', () => {
    expect(documentoCruceDeMovimiento({}, mapa)).toBeNull();
  });

  it('un SI que ya no se resuelve conserva lo almacenado', () => {
    expect(
      documentoCruceDeMovimiento(
        { tipoDocumento: 'SI', numeroDocumento: 9 },
        mapa,
      ),
    ).toEqual({ tipo: 'SI', numero: 9 });
  });
});
