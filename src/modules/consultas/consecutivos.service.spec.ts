import { Types } from 'mongoose';
import { ConsecutivosService } from './consecutivos.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const consecutivoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  category: 'IN',
  code: 'RC',
  prefix: 'RC',
  displayName: 'Recibo de Caja',
  nextNumber: 10,
  ...over,
});

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  code: '301',
  ...over,
});

const conceptoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  name: 'Administracion',
  sortOrder: 100,
  ...over,
});

const find = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

const findOneStub = (doc: unknown) => ({
  findOne: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(doc),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    consecutivos: findOneStub(consecutivoDoc()),
    facturas: find(),
    recibos: find(),
    notasCredito: find(),
    notasDebito: find(),
    notasContables: find(),
    notasAnticipo: find(),
    aplicaciones: find(),
    conceptosCobro: find(),
    inmuebles: find(),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };
  return new ConsecutivosService(
    m.consecutivos as never,
    m.facturas as never,
    m.recibos as never,
    m.notasCredito as never,
    m.notasDebito as never,
    m.notasContables as never,
    m.notasAnticipo as never,
    m.aplicaciones as never,
    m.conceptosCobro as never,
    m.inmuebles as never,
    m.tenant as never,
  );
};

describe('ConsecutivosService', () => {
  it('lanza NotFoundException cuando el código no existe en la Tabla de Documentos', async () => {
    const svc = servicio({ consecutivos: findOneStub(null) });

    await expect(
      svc.findAll({ codigo: 'XX', desde: '2026-01-01', hasta: '2026-01-31' }),
    ).rejects.toThrow('No existe el tipo de documento "XX"');
  });

  describe('categoria IN (Recibo)', () => {
    it('suma detalleConceptos de las aplicaciones activas del recibo', async () => {
      const inmId = id();
      const reciboId = id();
      const conceptoId = id();
      const recibo = {
        _id: reciboId,
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 5,
        fullNumber: 'RC-5',
        receivedAmount: 100000,
        receivedDate: new Date('2026-01-15'),
      };
      const inm = inmuebleDoc({ _id: inmId, code: '301' });
      const concepto = conceptoDoc({ _id: conceptoId, name: 'Administracion' });
      const app = {
        _id: id(),
        sourceType: 'RC',
        sourceId: reciboId,
        status: 'activa',
        detalleConceptos: [
          { conceptoId, conceptName: 'Administracion', monto: 100000 },
        ],
      };

      const svc = servicio({
        recibos: find([recibo]),
        aplicaciones: find([app]),
        inmuebles: find([inm]),
        conceptosCobro: find([concepto]),
      });

      const result = await svc.findAll({
        codigo: 'RC',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas).toHaveLength(1);
      expect(result.filas[0]).toMatchObject({
        tipoDocumento: 'RC',
        numeroCompleto: 'RC-5',
        inmuebleCodigo: '301',
        valorTotal: 100000,
        cargosPorConcepto: { [conceptoId.toString()]: 100000 },
      });
      expect(result.conceptos).toEqual([
        { conceptoId: conceptoId.toString(), nombre: 'Administracion' },
      ]);
    });

    it('un recibo sin aplicaciones (anticipo sin aplicar) muestra cargosPorConcepto vacío', async () => {
      const inmId = id();
      const recibo = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 6,
        fullNumber: 'RC-6',
        receivedAmount: 50000,
        receivedDate: new Date('2026-01-20'),
      };
      const inm = inmuebleDoc({ _id: inmId, code: '301' });

      const svc = servicio({
        recibos: find([recibo]),
        inmuebles: find([inm]),
      });

      const result = await svc.findAll({
        codigo: 'RC',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas[0].cargosPorConcepto).toEqual({});
      expect(result.filas[0].valorTotal).toBe(50000);
    });
  });

  describe('categoria ND (Nota Debito)', () => {
    it('usa su propio conceptoId y total', async () => {
      const inmId = id();
      const conceptoId = id();
      const nd = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        conceptoId,
        number: 3,
        fullNumber: 'ND-3',
        issueDate: new Date('2026-01-10'),
        total: 20000,
        status: 'emitida',
      };
      const inm = inmuebleDoc({ _id: inmId, code: '302' });
      const concepto = conceptoDoc({ _id: conceptoId, name: 'Multas' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ category: 'ND', code: 'ND', prefix: 'ND' }),
        ),
        notasDebito: find([nd]),
        inmuebles: find([inm]),
        conceptosCobro: find([concepto]),
      });

      const result = await svc.findAll({
        codigo: 'ND',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas[0]).toMatchObject({
        tipoDocumento: 'ND',
        numeroCompleto: 'ND-3',
        inmuebleCodigo: '302',
        valorTotal: 20000,
        cargosPorConcepto: { [conceptoId.toString()]: 20000 },
      });
    });
  });

  describe('categoria NC (Nota Credito)', () => {
    it('usa su propia distribution', async () => {
      const inmId = id();
      const conceptoAdmin = id();
      const conceptoMultas = id();
      const nc = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 2,
        fullNumber: 'NC-2',
        issueDate: new Date('2026-01-12'),
        totalAmount: 30000,
        status: 'activo',
        distribution: [
          { conceptoId: conceptoAdmin, amount: 20000 },
          { conceptoId: conceptoMultas, amount: 10000 },
        ],
      };
      const inm = inmuebleDoc({ _id: inmId, code: '303' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ category: 'NC', code: 'NC', prefix: 'NC' }),
        ),
        notasCredito: find([nc]),
        inmuebles: find([inm]),
      });

      const result = await svc.findAll({
        codigo: 'NC',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas[0].cargosPorConcepto).toEqual({
        [conceptoAdmin.toString()]: 20000,
        [conceptoMultas.toString()]: 10000,
      });
    });

    it('una nota sin issueDate cae al createdAt (fallback fechaNotaCredito), fuera de rango se excluye', async () => {
      const inmId = id();
      const nc = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 1,
        fullNumber: 'NC-1',
        issueDate: null,
        createdAt: new Date('2026-03-01'),
        totalAmount: 10000,
        status: 'activo',
        distribution: [],
      };
      const inm = inmuebleDoc({ _id: inmId, code: '303' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ category: 'NC', code: 'NC', prefix: 'NC' }),
        ),
        notasCredito: find([nc]),
        inmuebles: find([inm]),
      });

      const result = await svc.findAll({
        codigo: 'NC',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas).toHaveLength(0);
    });
  });

  describe('categoria NT (Nota Contable)', () => {
    it('el concepto origen queda negativo y el destino positivo, mismo monto', async () => {
      const inmId = id();
      const conceptoOrigen = id();
      const conceptoDestino = id();
      const nt = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 4,
        fullNumber: 'NT-4',
        issueDate: new Date('2026-01-18'),
        conceptoOrigenId: conceptoOrigen,
        conceptoDestinoId: conceptoDestino,
        monto: 15000,
        status: 'activo',
      };
      const inm = inmuebleDoc({ _id: inmId, code: '304' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ category: 'NT', code: 'NT', prefix: 'NT' }),
        ),
        notasContables: find([nt]),
        inmuebles: find([inm]),
      });

      const result = await svc.findAll({
        codigo: 'NT',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas[0].cargosPorConcepto).toEqual({
        [conceptoOrigen.toString()]: -15000,
        [conceptoDestino.toString()]: 15000,
      });
      expect(result.filas[0].valorTotal).toBe(15000);
    });

    it('un código NT usado para Notas de Anticipo las trae desde NotaAnticipo, no NotaContable (bug real reportado)', async () => {
      const inmId = id();
      const conceptoId = id();
      const notaId = id();
      const na = {
        _id: notaId,
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 1,
        fullNumber: 'NA-1',
        issueDate: new Date('2026-08-01'),
        appliedAmount: 40000,
        status: 'activo',
      };
      const app = {
        _id: id(),
        sourceType: 'NA',
        sourceId: notaId,
        status: 'activa',
        detalleConceptos: [
          { conceptoId, conceptName: 'Administracion', monto: 40000 },
        ],
      };
      const inm = inmuebleDoc({ _id: inmId, code: '307' });
      const concepto = conceptoDoc({ _id: conceptoId, name: 'Administracion' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ category: 'NT', code: 'NA', prefix: 'NA' }),
        ),
        notasContables: find([]),
        notasAnticipo: find([na]),
        aplicaciones: find([app]),
        inmuebles: find([inm]),
        conceptosCobro: find([concepto]),
      });

      const result = await svc.findAll({
        codigo: 'NA',
        desde: '2026-08-01',
        hasta: '2026-08-31',
      });

      expect(result.filas).toHaveLength(1);
      expect(result.filas[0]).toMatchObject({
        tipoDocumento: 'NA',
        numeroCompleto: 'NA-1',
        inmuebleCodigo: '307',
        valorTotal: 40000,
        cargosPorConcepto: { [conceptoId.toString()]: 40000 },
      });
    });
  });

  describe('categoria FV (Factura, fallback sin resolución)', () => {
    it('usa sus propias lines', async () => {
      const inmId = id();
      const conceptoId = id();
      const f = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        number: 100,
        fullNumber: 'FV-100',
        issueDate: new Date('2026-01-05'),
        total: 50000,
        status: 'emitida',
        lines: [{ conceptoId, totalAmount: 50000 }],
      };
      const inm = inmuebleDoc({ _id: inmId, code: '305' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ category: 'FV', code: 'FV', prefix: 'FV' }),
        ),
        facturas: find([f]),
        inmuebles: find([inm]),
      });

      const result = await svc.findAll({
        codigo: 'FV',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas[0]).toMatchObject({
        tipoDocumento: 'FV',
        numeroCompleto: 'FV-100',
        valorTotal: 50000,
        cargosPorConcepto: { [conceptoId.toString()]: 50000 },
      });
    });
  });

  it('ordena las filas por numero ascendente', async () => {
    const inmId = id();
    const nd1 = {
      _id: id(),
      coPropertyId: COP,
      inmuebleId: inmId,
      conceptoId: id(),
      number: 9,
      fullNumber: 'ND-9',
      issueDate: new Date('2026-01-10'),
      total: 1000,
      status: 'emitida',
    };
    const nd2 = {
      _id: id(),
      coPropertyId: COP,
      inmuebleId: inmId,
      conceptoId: id(),
      number: 2,
      fullNumber: 'ND-2',
      issueDate: new Date('2026-01-05'),
      total: 1000,
      status: 'emitida',
    };
    const inm = inmuebleDoc({ _id: inmId, code: '306' });

    const svc = servicio({
      consecutivos: findOneStub(
        consecutivoDoc({ category: 'ND', code: 'ND', prefix: 'ND' }),
      ),
      notasDebito: find([nd1, nd2]),
      inmuebles: find([inm]),
    });

    const result = await svc.findAll({
      codigo: 'ND',
      desde: '2026-01-01',
      hasta: '2026-01-31',
    });

    expect(result.filas.map((f) => f.numeroCompleto)).toEqual(['ND-2', 'ND-9']);
  });
});
