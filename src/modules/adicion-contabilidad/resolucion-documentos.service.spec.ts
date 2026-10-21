import { Types } from 'mongoose';
import {
  ResolucionDocumentosService,
  detalleDeAsiento,
  tipoDocumentoDe,
} from './resolucion-documentos.service';

const COP = new Types.ObjectId();

const anclas = {
  facturaId: null,
  reciboId: null,
  notaCreditoId: null,
  notaDebitoId: null,
  notaContableId: null,
  notaAnticipoId: null,
};

const asiento = (over: Record<string, unknown>) =>
  ({
    ...anclas,
    movimientos: [{ descripcion: 'Texto fijo del asiento' }],
    ...over,
  }) as never;

describe('tipoDocumentoDe', () => {
  it.each([
    ['facturaId', 'FV'],
    ['reciboId', 'RC'],
    ['notaCreditoId', 'NC'],
    ['notaDebitoId', 'ND'],
    ['notaContableId', 'NT'],
    ['notaAnticipoId', 'NA'],
  ])('%s → %s', (campo, tipo) => {
    expect(tipoDocumentoDe(asiento({ [campo]: new Types.ObjectId() }))).toBe(
      tipo,
    );
  });
});

describe('detalleDeAsiento', () => {
  it('prefiere el concepto del documento ancla', () => {
    const reciboId = new Types.ObjectId();
    expect(
      detalleDeAsiento(
        asiento({ reciboId }),
        new Map([[reciboId.toString(), 'Pago octubre']]),
      ),
    ).toBe('Pago octubre');
  });

  it('sin concepto propio usa el texto del primer movimiento', () => {
    expect(
      detalleDeAsiento(asiento({ reciboId: new Types.ObjectId() }), new Map()),
    ).toBe('Texto fijo del asiento');
  });
});

describe('ResolucionDocumentosService.buildAnchorMap', () => {
  it('resuelve prefijo y número de cada ancla filtrando por la copropiedad', async () => {
    const facturaId = new Types.ObjectId();
    const filtros: unknown[] = [];
    const facturas = {
      find: jest.fn((filtro: unknown) => {
        filtros.push(filtro);
        return {
          session: () => ({
            exec: () =>
              Promise.resolve([
                { _id: facturaId, prefijo: 'FEVP', numero: 4152 },
              ]),
          }),
        };
      }),
    };
    const vacio = { find: jest.fn() };
    const service = new ResolucionDocumentosService(
      facturas as never,
      vacio as never,
      vacio as never,
      vacio as never,
      vacio as never,
      vacio as never,
    );

    const mapa = await service.buildAnchorMap(
      [asiento({ facturaId })],
      COP,
      null,
    );

    expect(mapa.get(facturaId.toString())).toEqual({
      prefix: 'FEVP',
      number: 4152,
    });
    expect(filtros[0]).toEqual({
      _id: { $in: [facturaId] },
      copropiedadId: COP,
    });
    expect(vacio.find).not.toHaveBeenCalled();
  });
});
