import { Types } from 'mongoose';
import { ConsecutivosService } from './consecutivos.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const consecutivoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  categoria: 'IN',
  codigo: 'RC',
  prefijo: 'RC',
  nombreDocumento: 'Recibo de Caja',
  siguienteNumero: 10,
  ...over,
});

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  codigo: '301',
  ...over,
});

const conceptoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  nombre: 'Administracion',
  orden: 100,
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
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 5,
        numeroCompleto: 'RC-5',
        montoRecibido: 100000,
        fechaRecibo: new Date('2026-01-15'),
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '301' });
      const concepto = conceptoDoc({
        _id: conceptoId,
        nombre: 'Administracion',
      });
      const app = {
        _id: id(),
        sourceType: 'RC',
        sourceId: reciboId,
        estado: 'activa',
        detalleConceptos: [
          { conceptoId, nombreConcepto: 'Administracion', monto: 100000 },
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
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 6,
        numeroCompleto: 'RC-6',
        montoRecibido: 50000,
        fechaRecibo: new Date('2026-01-20'),
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '301' });

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

    it('trae otros ingresos del recibo y suma el descuento de sus aplicaciones activas', async () => {
      const inmId = id();
      const reciboId = id();
      const conceptoId = id();
      const recibo = {
        _id: reciboId,
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 7,
        numeroCompleto: 'RC-7',
        montoRecibido: 150000,
        montoOtrosIngresos: 15000,
        fechaRecibo: new Date('2026-01-18'),
      };
      const app = (montoDescuento: number) => ({
        _id: id(),
        sourceType: 'RC',
        sourceId: reciboId,
        estado: 'activa',
        montoDescuento,
        montoAplicado: 60000,
        detalleConceptos: [
          { conceptoId, nombreConcepto: 'Administracion', monto: 60000 },
        ],
      });

      const svc = servicio({
        recibos: find([recibo]),
        aplicaciones: find([app(3000), app(2000)]),
        inmuebles: find([inmuebleDoc({ _id: inmId })]),
        conceptosCobro: find([conceptoDoc({ _id: conceptoId })]),
      });

      const result = await svc.findAll({
        codigo: 'RC',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.esRecibo).toBe(true);
      expect(result.columnas).toEqual({
        anticipos: true,
        otrosIngresos: true,
        descuento: true,
      });
      expect(result.filas[0]).toMatchObject({
        valorTotal: 150000,
        montoOtrosIngresos: 15000,
        montoDescuento: 5000,
        // 150000 recibido − 15000 otros ingresos − (120000 aplicado − 5000
        // descuento) en efectivo = 20000 a anticipos. Cuadra:
        // 120000 conceptos − 5000 + 15000 + 20000 = 150000.
        montoAnticipo: 20000,
      });
    });
  });

  describe('categoria ND (Nota Debito)', () => {
    it('usa su propio conceptoId y total', async () => {
      const inmId = id();
      const conceptoId = id();
      const nd = {
        _id: id(),
        copropiedadId: COP,
        inmuebleId: inmId,
        conceptoId,
        numero: 3,
        numeroCompleto: 'ND-3',
        fechaEmision: new Date('2026-01-10'),
        total: 20000,
        estado: 'emitida',
        motivo: 'cambio_valor',
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '302' });
      const concepto = conceptoDoc({ _id: conceptoId, nombre: 'Multas' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'ND', codigo: 'ND', prefijo: 'ND' }),
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
        montoOtrosIngresos: 0,
        montoDescuento: 0,
        cargosPorConcepto: { [conceptoId.toString()]: 20000 },
      });
      expect(result.esRecibo).toBe(false);
      expect(result.columnas).toEqual({
        anticipos: false,
        otrosIngresos: true,
        descuento: false,
      });
    });
  });

  describe('categoria ND — columna Otros Ingresos', () => {
    it('va el total salvo con motivo cambio de valor o concepto de intereses', async () => {
      const inmId = id();
      const conceptoMultas = id();
      const conceptoMora = id();
      const nd = (
        numero: number,
        motivo: string,
        conceptoId: Types.ObjectId,
      ) => ({
        _id: id(),
        copropiedadId: COP,
        inmuebleId: inmId,
        conceptoId,
        numero,
        numeroCompleto: `ND-${numero}`,
        fechaEmision: new Date('2026-01-10'),
        total: 20000,
        estado: 'emitida',
        motivo,
      });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'ND', codigo: 'ND', prefijo: 'ND' }),
        ),
        notasDebito: find([
          nd(1, 'gastos_por_cobrar', conceptoMultas),
          nd(2, 'cambio_valor', conceptoMultas),
          nd(3, 'intereses', conceptoMora),
        ]),
        inmuebles: find([inmuebleDoc({ _id: inmId })]),
        conceptosCobro: find([
          conceptoDoc({ _id: conceptoMultas, nombre: 'Multas', tipo: 'otro' }),
          conceptoDoc({
            _id: conceptoMora,
            nombre: 'Intereses',
            tipo: 'intereses',
          }),
        ]),
      });

      const result = await svc.findAll({
        codigo: 'ND',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.filas.map((f) => f.montoOtrosIngresos)).toEqual([
        20000, 0, 0,
      ]);
    });
  });

  describe('categoria NC (Nota Credito)', () => {
    it('usa su propia distribution', async () => {
      const inmId = id();
      const conceptoAdmin = id();
      const conceptoMultas = id();
      const nc = {
        _id: id(),
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 2,
        numeroCompleto: 'NC-2',
        fecha: new Date('2026-01-12'),
        montoTotal: 30000,
        estado: 'activo',
        distribucion: [
          { conceptoId: conceptoAdmin, monto: 20000 },
          { conceptoId: conceptoMultas, monto: 10000 },
        ],
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '303' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'NC', codigo: 'NC', prefijo: 'NC' }),
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

    it('motivo descuento: todo su valor va en Descuento; otro motivo queda en 0', async () => {
      const inmId = id();
      const nota = (numero: number, motivo: string) => ({
        _id: id(),
        copropiedadId: COP,
        inmuebleId: inmId,
        numero,
        numeroCompleto: `NC-${numero}`,
        fecha: new Date('2026-01-12'),
        motivo,
        montoTotal: 30000,
        estado: 'activo',
        distribucion: [],
      });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'NC', codigo: 'NC', prefijo: 'NC' }),
        ),
        notasCredito: find([nota(1, 'descuento'), nota(2, 'ajuste_precio')]),
        inmuebles: find([inmuebleDoc({ _id: inmId })]),
      });

      const result = await svc.findAll({
        codigo: 'NC',
        desde: '2026-01-01',
        hasta: '2026-01-31',
      });

      expect(result.columnas).toEqual({
        anticipos: false,
        otrosIngresos: false,
        descuento: true,
      });
      expect(result.filas.map((f) => f.montoDescuento)).toEqual([30000, 0]);
    });

    it('una nota sin issueDate cae al createdAt (fallback fechaNotaCredito), fuera de rango se excluye', async () => {
      const inmId = id();
      const nc = {
        _id: id(),
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 1,
        numeroCompleto: 'NC-1',
        fecha: null,
        createdAt: new Date('2026-03-01'),
        montoTotal: 10000,
        estado: 'activo',
        distribucion: [],
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '303' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'NC', codigo: 'NC', prefijo: 'NC' }),
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
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 4,
        numeroCompleto: 'NT-4',
        fecha: new Date('2026-01-18'),
        conceptoOrigenId: conceptoOrigen,
        conceptoDestinoId: conceptoDestino,
        monto: 15000,
        estado: 'activo',
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '304' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'NT', codigo: 'NT', prefijo: 'NT' }),
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
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 1,
        numeroCompleto: 'NA-1',
        fechaEmision: new Date('2026-08-01'),
        montoAplicado: 40000,
        estado: 'activo',
      };
      const app = {
        _id: id(),
        sourceType: 'NA',
        sourceId: notaId,
        estado: 'activa',
        detalleConceptos: [
          { conceptoId, nombreConcepto: 'Administracion', monto: 40000 },
        ],
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '307' });
      const concepto = conceptoDoc({
        _id: conceptoId,
        nombre: 'Administracion',
      });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'NT', codigo: 'NA', prefijo: 'NA' }),
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
        copropiedadId: COP,
        inmuebleId: inmId,
        numero: 100,
        numeroCompleto: 'FV-100',
        fechaEmision: new Date('2026-01-05'),
        total: 50000,
        estado: 'emitida',
        lineas: [{ conceptoId, valorTotal: 50000 }],
      };
      const inm = inmuebleDoc({ _id: inmId, codigo: '305' });

      const svc = servicio({
        consecutivos: findOneStub(
          consecutivoDoc({ categoria: 'FV', codigo: 'FV', prefijo: 'FV' }),
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
      copropiedadId: COP,
      inmuebleId: inmId,
      conceptoId: id(),
      numero: 9,
      numeroCompleto: 'ND-9',
      fechaEmision: new Date('2026-01-10'),
      total: 1000,
      estado: 'emitida',
    };
    const nd2 = {
      _id: id(),
      copropiedadId: COP,
      inmuebleId: inmId,
      conceptoId: id(),
      numero: 2,
      numeroCompleto: 'ND-2',
      fechaEmision: new Date('2026-01-05'),
      total: 1000,
      estado: 'emitida',
    };
    const inm = inmuebleDoc({ _id: inmId, codigo: '306' });

    const svc = servicio({
      consecutivos: findOneStub(
        consecutivoDoc({ categoria: 'ND', codigo: 'ND', prefijo: 'ND' }),
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
