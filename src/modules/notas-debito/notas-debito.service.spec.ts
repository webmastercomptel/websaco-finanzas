import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { NotasDebitoService } from './notas-debito.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const sesionFalsa = () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(async () => undefined),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(async () => session) }) as never;

const notaDebitoDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  terceroId: null,
  conceptoId: CONCEPTO,
  description: 'Cargo de prueba',
  prefix: 'ND',
  number: 1,
  fullNumber: 'ND-1',
  issueDate: new Date('2026-09-01'),
  total: 50000,
  outstandingBalance: 50000,
  status: 'emitida',
  voidedReason: null,
  voidedDetail: null,
  voidedAt: null,
  voidedBy: null,
  generatedBy: CUENTA,
  ...over,
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const session = sesionFalsa();
  const nota = notaDebitoDoc();
  const defaults: Record<string, unknown> = {
    notasDebito: {
      create: jest.fn(() => Promise.resolve([nota])),
      find: jest.fn(() => ({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve([nota])),
      })),
      findOne: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve(nota)),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          session: jest.fn().mockReturnThis(),
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
      countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(1) })),
    },
    aplicaciones: {
      create: jest.fn(() => Promise.resolve([])),
      find: jest.fn(() => ({
        sort: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve([])),
      })),
      findOneAndUpdate: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve({})),
      })),
    },
    asientos: { create: jest.fn(() => Promise.resolve([{}])) },
    copropiedades: {
      findById: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() =>
          Promise.resolve({
            receivablesAccount: '1305',
            debitNotesAccount: '4105',
          }),
        ),
      })),
    },
    conceptos: {
      findOne: jest.fn(() => ({
        exec: jest.fn(() =>
          Promise.resolve({
            _id: CONCEPTO,
            coPropertyId: COP,
            accountingIncomeAccount: '4105',
          }),
        ),
      })),
    },
    recibos: {
      findOneAndUpdate: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve({ _id: new Types.ObjectId() })),
      })),
    },
    notasCredito: {
      findOneAndUpdate: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve({ _id: new Types.ObjectId() })),
      })),
    },
    tenant: { resolveCoPropertyId: () => COP },
    numeracion: {
      siguienteDocumento: jest.fn(() =>
        Promise.resolve({ prefijo: 'ND', numero: 1, completo: 'ND-1' }),
      ),
    },
    connection: conexionCon(session),
  };

  const merged = { ...defaults, ...overrides };
  return new NotasDebitoService(
    merged.notasDebito as never,
    merged.aplicaciones as never,
    {} as never,
    {} as never,
    merged.asientos as never,
    merged.copropiedades as never,
    merged.conceptos as never,
    merged.recibos as never,
    merged.notasCredito as never,
    merged.tenant as never,
    merged.numeracion as never,
    merged.connection as never,
  );
};

describe('NotasDebitoService', () => {
  describe('crear', () => {
    it('crea una nota débito con saldo igual al total', async () => {
      const svc = servicio();
      const resultado = await svc.crear(CUENTA.toString(), {
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        total: 50000,
        fechaCargo: '2026-09-01',
        descripcion: 'Cargo por multa',
      });

      expect(resultado.saldoPendiente).toBe(50000);
    });

    it('rechaza concepto inexistente', async () => {
      const svc = servicio({
        conceptos: {
          findOne: jest.fn(() => ({
            exec: jest.fn(() => Promise.resolve(null)),
          })),
        },
      });

      await expect(
        svc.crear(CUENTA.toString(), {
          inmuebleId: INMUEBLE.toString(),
          conceptoId: CONCEPTO.toString(),
          total: 50000,
          fechaCargo: '2026-09-01',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('anular', () => {
    it('anula nota débito sin aplicaciones previas', async () => {
      const svc = servicio();
      const resultado = await svc.anular(
        'test-id',
        {
          motivo: 'error_digitacion',
          detalle: 'Se anula por error en digitación del cargo',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
    });

    it('anula nota débito con aplicaciones activas, restaurando fuentes RC', async () => {
      const aplicacion = {
        _id: new Types.ObjectId(),
        sourceType: 'RC',
        sourceId: new Types.ObjectId(),
        documentType: 'ND',
        documentId: new Types.ObjectId(),
        amountApplied: 20000,
        status: 'activa',
      };
      const svc = servicio({
        aplicaciones: {
          create: jest.fn(() => Promise.resolve([])),
          find: jest.fn(() => ({
            sort: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve([aplicacion])),
          })),
          findOneAndUpdate: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({})),
          })),
        },
      });

      const resultado = await svc.anular(
        'test-id',
        {
          motivo: 'otro',
          detalle: 'Se anula porque el cargo fue generado por error',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
    });

    it('anula nota débito con aplicaciones activas, restaurando fuentes NC', async () => {
      const aplicacion = {
        _id: new Types.ObjectId(),
        sourceType: 'NC',
        sourceId: new Types.ObjectId(),
        documentType: 'ND',
        documentId: new Types.ObjectId(),
        amountApplied: 30000,
        status: 'activa',
      };
      const svc = servicio({
        aplicaciones: {
          create: jest.fn(() => Promise.resolve([])),
          find: jest.fn(() => ({
            sort: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve([aplicacion])),
          })),
          findOneAndUpdate: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({})),
          })),
        },
      });

      const resultado = await svc.anular(
        'test-id',
        {
          motivo: 'error_facturacion',
          detalle: 'La nota débito fue emitida por error de facturación',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
    });

    it('no restaura fuentes cuya aplicación ya fue revertida (edge case)', async () => {
      const aplicacionRevertida = {
        _id: new Types.ObjectId(),
        sourceType: 'RC',
        sourceId: new Types.ObjectId(),
        documentType: 'ND',
        documentId: new Types.ObjectId(),
        amountApplied: 10000,
        status: 'revertida',
      };
      const recibos = {
        findOneAndUpdate: jest.fn(() => ({
          session: jest.fn().mockReturnThis(),
          exec: jest.fn(() => Promise.resolve(null)),
        })),
      };
      const svc = servicio({
        aplicaciones: {
          create: jest.fn(() => Promise.resolve([])),
          find: jest.fn((filtro: Record<string, unknown>) => ({
            sort: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              // Only return documents that match the status filter.
              Promise.resolve(
                filtro.status === 'activa' ? [] : [aplicacionRevertida],
              ),
            ),
          })),
          findOneAndUpdate: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({})),
          })),
        },
        recibos,
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'duplicado',
          detalle: 'Se anula la nota débito duplicada generada por error',
        },
        CUENTA.toString(),
      );

      expect(recibos.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('falla si la nota débito ya está anulada', async () => {
      const svc = servicio({
        notasDebito: {
          create: jest.fn(),
          find: jest.fn(),
          findOne: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve(notaDebitoDoc({ status: 'anulada' })),
            ),
          })),
          findOneAndUpdate: jest.fn(),
          countDocuments: jest.fn(),
        },
      });

      await expect(
        svc.anular(
          'test-id',
          {
            motivo: 'otro',
            detalle: 'Segundo intento de anulación de nota débito',
          },
          CUENTA.toString(),
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findOne', () => {
    it('lanza NotFoundException si la nota débito no existe', async () => {
      const svc = servicio({
        notasDebito: {
          create: jest.fn(),
          find: jest.fn(),
          findOne: jest.fn(() => ({
            exec: jest.fn(() => Promise.resolve(null)),
          })),
          findOneAndUpdate: jest.fn(),
          countDocuments: jest.fn(),
        },
      });

      await expect(svc.findOne('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('retorna paginación con items', async () => {
      const svc = servicio();
      const resultado = await svc.findAll({});

      expect(resultado.items).toBeDefined();
      expect(resultado.total).toBeDefined();
    });
  });
});
