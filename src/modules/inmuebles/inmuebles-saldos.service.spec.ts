import 'reflect-metadata';
import { Types } from 'mongoose';
import { InmueblesSaldosService } from './inmuebles-saldos.service';
import { InmueblesController } from './inmuebles.controller';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
} from '../casl/check-ability.decorator';

// The controller imports the report service, which pulls in the PDF renderer
// (not loadable under jest) — the roster PDF is irrelevant here.
jest.mock('../../common/pdf/inmuebles-listado-pdf', () => ({
  generarPdfListadoInmuebles: jest.fn(),
}));

const COP = new Types.ObjectId();
const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

type Fila = Record<string, unknown> & { _id: Types.ObjectId };

/** Lean-chainable model that honours the `inmuebleId.$in` and `estado`
 *  filters the service sends, like Mongo would — so "ignores anuladas" is
 *  proven by the filter, not by the fixture being pre-cleaned. */
const modelo = (filas: Fila[]) => ({
  find: jest.fn((filtro: Record<string, unknown>) => {
    const inmuebles = (filtro.inmuebleId as { $in?: unknown[] } | undefined)
      ?.$in;
    const resultado = filas.filter(
      (f) =>
        (!inmuebles || inmuebles.map(String).includes(String(f.inmuebleId))) &&
        (!filtro.estado || f.estado === filtro.estado),
    );
    const cadena = {
      lean: () => cadena,
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  }),
});

const modeloSaldos = (
  filas: { documentoId: Types.ObjectId; saldoPendiente: number }[],
) => ({
  find: jest.fn((filtro: { documentoId: { $in: unknown[] } }) => {
    const ids = filtro.documentoId.$in.map(String);
    const resultado = filas.filter((f) => ids.includes(String(f.documentoId)));
    const cadena = {
      lean: () => cadena,
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  }),
});

const INM_A = new Types.ObjectId();
const INM_B = new Types.ObjectId();
const INM_SIN_DEUDA = new Types.ObjectId();
const INM_AJENO = new Types.ObjectId();

const doc = (inmuebleId: Types.ObjectId, estado: string): Fila => ({
  _id: new Types.ObjectId(),
  inmuebleId,
  estado,
});

const construir = (config: {
  facturas?: Fila[];
  notasDebito?: Fila[];
  saldosIniciales?: Fila[];
  saldos?: { documentoId: Types.ObjectId; saldoPendiente: number }[];
}) => {
  // The foreign unit exists, but under another coproperty: the tenant-scoped
  // lookup (which mimics `copropiedadId` here) must not return it.
  const inmuebles = {
    find: jest.fn(
      (filtro: { copropiedadId: unknown; _id: { $in: unknown[] } }) => {
        const propios = [INM_A, INM_B, INM_SIN_DEUDA].filter((i) =>
          filtro._id.$in.map(String).includes(String(i)),
        );
        const cadena = {
          lean: () => cadena,
          exec: () => Promise.resolve(propios.map((_id) => ({ _id }))),
        };
        return cadena;
      },
    ),
  };
  const facturas = modelo(config.facturas ?? []);
  const notasDebito = modelo(config.notasDebito ?? []);
  const saldosIniciales = modelo(config.saldosIniciales ?? []);
  const saldoTotal = modeloSaldos(config.saldos ?? []);
  const service = new InmueblesSaldosService(
    inmuebles as never,
    facturas as never,
    notasDebito as never,
    saldosIniciales as never,
    saldoTotal as never,
    tenant(),
  );
  return {
    service,
    inmuebles,
    facturas,
    notasDebito,
    saldosIniciales,
    saldoTotal,
  };
};

describe('InmueblesSaldosService.consultar', () => {
  it('suma por inmueble los saldos de facturas, notas débito y saldos iniciales', async () => {
    const fvA = doc(INM_A, 'emitida');
    const ndA = doc(INM_A, 'emitida');
    const siA = doc(INM_A, 'activo');
    const fvB = doc(INM_B, 'emitida');
    const { service } = construir({
      facturas: [fvA, fvB],
      notasDebito: [ndA],
      saldosIniciales: [siA],
      saldos: [
        { documentoId: fvA._id, saldoPendiente: 100000.1 },
        { documentoId: ndA._id, saldoPendiente: 20000.2 },
        { documentoId: siA._id, saldoPendiente: 5000 },
        { documentoId: fvB._id, saldoPendiente: 70000 },
      ],
    });

    const resultado = await service.consultar({
      ids: [INM_A.toString(), INM_B.toString()],
    });

    expect(resultado).toEqual([
      { inmuebleId: INM_A.toString(), saldoPendiente: 125000.3 },
      { inmuebleId: INM_B.toString(), saldoPendiente: 70000 },
    ]);
  });

  it('ignora las anuladas pidiendo solo emitidas/activos y escopa por copropiedad', async () => {
    const fvAnulada = doc(INM_A, 'anulada');
    const fvVigente = doc(INM_A, 'emitida');
    const siAnulado = doc(INM_A, 'anulado');
    const { service, facturas, notasDebito, saldosIniciales, saldoTotal } =
      construir({
        facturas: [fvAnulada, fvVigente],
        saldosIniciales: [siAnulado],
        saldos: [
          { documentoId: fvAnulada._id, saldoPendiente: 999 },
          { documentoId: fvVigente._id, saldoPendiente: 300 },
          { documentoId: siAnulado._id, saldoPendiente: 999 },
        ],
      });

    const resultado = await service.consultar({ ids: [INM_A.toString()] });

    expect(resultado).toEqual([
      { inmuebleId: INM_A.toString(), saldoPendiente: 300 },
    ]);
    expect(facturas.find.mock.calls[0][0]).toMatchObject({
      copropiedadId: COP,
      estado: 'emitida',
    });
    expect(notasDebito.find.mock.calls[0][0]).toMatchObject({
      copropiedadId: COP,
      estado: 'emitida',
    });
    expect(saldosIniciales.find.mock.calls[0][0]).toMatchObject({
      copropiedadId: COP,
      estado: 'activo',
    });
    expect(saldoTotal.find.mock.calls[0][0]).toMatchObject({
      copropiedadId: COP,
    });
  });

  it('omite un id de otra copropiedad y nunca consulta sus documentos', async () => {
    const fvAjena = doc(INM_AJENO, 'emitida');
    const { service, facturas } = construir({
      facturas: [fvAjena],
      saldos: [{ documentoId: fvAjena._id, saldoPendiente: 500 }],
    });

    const resultado = await service.consultar({
      ids: [INM_AJENO.toString()],
    });

    expect(resultado).toEqual([]);
    expect(facturas.find).not.toHaveBeenCalled();
  });

  it('responde 0 para un inmueble sin deuda, sin saldo o con saldo negativo, y deduplica ids', async () => {
    const fvNegativa = doc(INM_A, 'emitida');
    const fvSinFila = doc(INM_A, 'emitida');
    const { service } = construir({
      facturas: [fvNegativa, fvSinFila],
      // `fvSinFila` has no saldo row at all: counts 0. A negative saldo is
      // floored at 0 per document, never netted against the others.
      saldos: [{ documentoId: fvNegativa._id, saldoPendiente: -50 }],
    });

    const resultado = await service.consultar({
      ids: [INM_A.toString(), INM_SIN_DEUDA.toString(), INM_A.toString()],
    });

    expect(resultado).toEqual([
      { inmuebleId: INM_A.toString(), saldoPendiente: 0 },
      { inmuebleId: INM_SIN_DEUDA.toString(), saldoPendiente: 0 },
    ]);
  });
});

describe('InmueblesController.consultarSaldos', () => {
  const handlerDe = (nombre: string): object =>
    Object.getOwnPropertyDescriptor(InmueblesController.prototype, nombre)
      ?.value as object;

  it('acepta leer Consulta O crear Factura (OR), sin reglas AND', () => {
    const handler = handlerDe('consultarSaldos');

    expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handler)).toEqual([
      { action: 'read', subject: 'Consulta' },
      { action: 'create', subject: 'Factura' },
    ]);
    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler)).toBeUndefined();
  });

  it('declara `saldos` antes de `:id` para que el parámetro no la trague', () => {
    const metodos = Object.getOwnPropertyNames(InmueblesController.prototype);

    expect(Reflect.getMetadata('path', handlerDe('consultarSaldos'))).toBe(
      'saldos',
    );
    expect(metodos.indexOf('consultarSaldos')).toBeLessThan(
      metodos.indexOf('findOne'),
    );
  });
});
