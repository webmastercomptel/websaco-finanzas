import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { NotasDebitoService } from './notas-debito.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const sesionFalsa = () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const notaDebitoDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  terceroId: null,
  conceptoId: CONCEPTO,
  descripcion: 'Cargo de prueba',
  prefijo: 'ND',
  numero: 1,
  numeroCompleto: 'ND-1',
  fechaEmision: new Date('2026-09-01'),
  fechaVencimiento: new Date('2026-09-30'),
  total: 50000,
  saldoPendiente: 50000,
  estado: 'emitida',
  motivoAnulacion: null,
  detalleAnulacion: null,
  fechaAnulacion: null,
  anuladoPor: null,
  generadoPor: CUENTA,
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
    saldos: {
      findOne: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve(null)),
      })),
      findOneAndUpdate: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve({})),
      })),
    },
    carteraPorDocumento: {
      create: jest.fn(() => Promise.resolve([{}])),
      updateOne: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve({})),
      })),
    },
    saldoTotalDocumento: {
      create: jest.fn(() => Promise.resolve([{}])),
      updateOne: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve({})),
      })),
      // `findAll`'s `conSaldoPendiente` candidate query and its per-row
      // batch lookup never chain a `.session()` call (outside any
      // transaction), matching the production code — `find` stays bare.
      find: jest.fn(() => ({
        exec: jest.fn(() =>
          Promise.resolve([
            { documentoId: nota._id, saldoPendiente: nota.saldoPendiente },
          ]),
        ),
      })),
      // `findOne` is called BOTH ways: bare `.exec()` from the read-only
      // `findOne()` service method, and `.session(session).exec()` from
      // `anular()`'s own transaction — `.session()` returns the same
      // chainable object so either call shape resolves.
      findOne: jest.fn(() => {
        const resultado = {
          documentoId: nota._id,
          saldoPendiente: nota.saldoPendiente,
        };
        const cadena = {
          session: () => cadena,
          exec: () => Promise.resolve(resultado),
        };
        return cadena;
      }),
    },
    asientos: { create: jest.fn(() => Promise.resolve([{}])) },
    copropiedades: {
      findById: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() =>
          Promise.resolve({
            cuentaContableCartera: '1305',
            cuentaNotasDebito: '4105',
          }),
        ),
      })),
    },
    conceptos: {
      findOne: jest.fn(() => ({
        populate: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() =>
          Promise.resolve({
            _id: CONCEPTO,
            copropiedadId: COP,
            tipo: 'administracion',
            cuentaCreditoId: { codigo: '4105' },
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
    notasAnticipo: {
      findOneAndUpdate: jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() => Promise.resolve(null)),
      })),
    },
    tenant: { resolveCoPropertyId: () => COP },
    numeracion: {
      siguienteDocumento: jest.fn(() =>
        Promise.resolve({ prefijo: 'ND', numero: 1, completo: 'ND-1' }),
      ),
    },
    connection: conexionCon(session),
    // No open Lote and no consolidated run in any test here — both guards
    // always pass.
    lotes: {
      exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
      obtenerUltimoConsolidado: jest.fn(() => Promise.resolve(null)),
    },
    // `restaurarMontoFuente`'s live target for RC/NC/NA sources —
    // unconditional `$inc`, no `.session()` chain (passed via the options
    // object instead), see `restaurarSaldoDocumentoOrigen`'s own signature.
    saldoDocumentoOrigen: {
      findOneAndUpdate: jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve({ saldoDisponible: 0 })),
      })),
    },
    // `crear()`'s own terceroId resolution (`Inmueble.titularId`) — no
    // titular by default; tests exercising a real one override this.
    // `find` backs `findAll`'s own batched `inmuebleCodigo` resolve — empty
    // by default, same reasoning tests that don't care about it stay green.
    inmuebles: {
      findOne: jest.fn(() => ({
        exec: jest.fn(() =>
          Promise.resolve({ _id: INMUEBLE, titularId: null }),
        ),
      })),
      find: jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve([])),
      })),
    },
  };

  const merged = { ...defaults, ...overrides };
  return new NotasDebitoService(
    merged.notasDebito as never,
    merged.aplicaciones as never,
    {} as never, // facturas
    merged.saldos as never,
    merged.carteraPorDocumento as never,
    merged.saldoTotalDocumento as never,
    merged.asientos as never,
    merged.copropiedades as never,
    merged.conceptos as never,
    merged.recibos as never,
    merged.notasCredito as never,
    merged.notasAnticipo as never,
    merged.tenant as never,
    merged.numeracion as never,
    merged.connection as never,
    merged.lotes as never,
    merged.saldoDocumentoOrigen as never,
    merged.inmuebles as never,
    merged.cuentasContables as never,
  );
};

describe('NotasDebitoService', () => {
  describe('crear', () => {
    it('crea una nota débito con saldo igual al total', async () => {
      const svc = servicio();
      const resultado = await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
        descripcion: 'Cargo por multa',
      });

      expect(resultado.saldoPendiente).toBe(50000);
    });

    it('congela terceroId desde el titularId ACTUAL del inmueble, nunca null a secas — el titular impreso en el PDF depende de esto', async () => {
      const TITULAR = new Types.ObjectId();
      const notasDebitoMock = {
        create: jest.fn((filas: Record<string, unknown>[]) =>
          Promise.resolve([{ ...notaDebitoDoc(), ...filas[0] }]),
        ),
        findOne: jest.fn(() => ({
          session: jest.fn().mockReturnThis(),
          exec: jest.fn(() => Promise.resolve(notaDebitoDoc())),
        })),
      };
      const svc = servicio({
        notasDebito: notasDebitoMock,
        inmuebles: {
          findOne: jest.fn(() => ({
            exec: jest.fn(() =>
              Promise.resolve({ _id: INMUEBLE, titularId: TITULAR }),
            ),
          })),
        },
      });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
      });

      const [[filas]] = notasDebitoMock.create.mock.calls as unknown as [
        Record<string, unknown>[],
      ][];
      expect(filas[0].terceroId).toBe(TITULAR);
    });

    it('rechaza un inmueble que no existe bajo este tenant — nunca crea la nota débito huérfana', async () => {
      const svc = servicio({
        inmuebles: {
          findOne: jest.fn(() => ({
            exec: jest.fn(() => Promise.resolve(null)),
          })),
        },
      });

      await expect(
        svc.crear(CUENTA.toString(), {
          codigo: 'ND',
          inmuebleId: INMUEBLE.toString(),
          conceptoId: CONCEPTO.toString(),
          motivo: 'otro',
          total: 50000,
          fechaCargo: '2026-09-01',
          fechaVencimiento: '2026-09-30',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('codifica el débito con la cuenta débito propia del concepto (cuentaDebitoId), no la cartera genérica de la copropiedad', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'administracion',
                cuentaCreditoId: { codigo: '4105' },
                cuentaDebitoId: { codigo: '130510' },
              }),
            ),
          })),
        },
      });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
      });

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string; tipo: string }> }[]],
      ];
      const debito = documentos[0].movimientos.find((e) => e.tipo === 'debito');
      expect(debito?.cuenta).toBe('130510');
      const cuentas = documentos[0].movimientos.map((e) => e.cuenta);
      expect(cuentas).not.toContain('1305');
    });

    it('sin cuentaDebitoId configurado en el concepto, cae de vuelta a la cartera genérica de la copropiedad', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      // El fixture por defecto de `servicio()` no trae `cuentaDebitoId` en
      // su concepto — mismo escenario que un concepto sin ese campo
      // configurado todavía.
      const svc = servicio({ asientos });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
      });

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string; tipo: string }> }[]],
      ];
      const debito = documentos[0].movimientos.find((e) => e.tipo === 'debito');
      expect(debito?.cuenta).toBe('1305');
    });

    it('postea el asiento con la fecha declarada (fechaEmision/fechaCargo), no el instante real del servidor', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      // La nota mockeada trae un fechaEmision bien distinto de "hoy" — si el
      // asiento se postea con `new Date()` en vez de `nota.fechaEmision`, esta
      // fecha nunca aparecería en la llamada.
      const svc = servicio({ asientos });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
      });

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ fecha: Date }[]],
      ];
      expect(documentos[0].fecha).toEqual(new Date('2026-09-01'));
    });

    it('agrega tercero/centroCosto/flujoCaja cuando cuentasContables está disponible', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '4105',
                centroCostoDefecto: 'CC-01',
                flujoCajaCodigo: 'FC-OPER',
              }),
            ),
          })),
        },
        cuentasContables: {
          find: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve([
                {
                  codigo: '4105',
                  requiereTercero: false,
                  centroUtilidad: false,
                  centroDestino: false,
                  flujoCaja: true,
                },
              ]),
            ),
          })),
        },
        inmuebles: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({ codigo: '1304' })),
          })),
          findOne: jest.fn(() => ({
            exec: jest.fn(() =>
              Promise.resolve({ _id: INMUEBLE, titularId: null }),
            ),
          })),
        },
      });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
        descripcion: 'Cargo por multa',
      });

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [
          {
            movimientos: Array<{
              cuenta: string;
              flujoCaja?: string | null;
            }>;
          }[],
        ],
      ];
      const credito = documentos[0].movimientos.find(
        (e) => e.cuenta === '4105',
      );
      expect(credito?.flujoCaja).toBe('FC-OPER');
    });

    it('NO mueve cuentas de orden cuando el concepto de la nota no es intereses', async () => {
      // Regresión: antes, la línea sintética armada para
      // `construirMovimientos` nunca traía `conceptKind`, así que
      // `cuentasOrden` NUNCA se movía — ni siquiera para una nota que sí
      // cobraba mora. Con un concepto NO-intereses, confirma que sigue sin
      // moverse (el comportamiento correcto para este caso).
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'administracion',
                cuentaCreditoId: { codigo: '4105' },
              }),
            ),
          })),
        },
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '4105',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
            ),
          })),
        },
      });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
      });

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string }> }[]],
      ];
      const cuentas = documentos[0].movimientos.map((e) => e.cuenta);
      expect(cuentas).not.toContain('831505');
      expect(cuentas).not.toContain('831510');
    });

    it('mueve cuentas de orden cuando el concepto de la nota SÍ es intereses', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'intereses',
                cuentaCreditoId: { codigo: '413599' },
              }),
            ),
          })),
        },
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '4105',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
            ),
          })),
        },
      });

      await svc.crear(CUENTA.toString(), {
        codigo: 'ND',
        inmuebleId: INMUEBLE.toString(),
        conceptoId: CONCEPTO.toString(),
        motivo: 'otro',
        total: 50000,
        fechaCargo: '2026-09-01',
        fechaVencimiento: '2026-09-30',
      });

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string; monto: number }> }[]],
      ];
      const memo = documentos[0].movimientos.find(
        (e) => e.cuenta === '831505' || e.cuenta === '831510',
      );
      expect(memo?.monto).toBe(50000);
    });

    it('rechaza concepto inexistente', async () => {
      const svc = servicio({
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve(null)),
          })),
        },
      });

      await expect(
        svc.crear(CUENTA.toString(), {
          codigo: 'ND',
          inmuebleId: INMUEBLE.toString(),
          conceptoId: CONCEPTO.toString(),
          motivo: 'otro',
          total: 50000,
          fechaCargo: '2026-09-01',
          fechaVencimiento: '2026-09-30',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rechaza una fecha de cargo fuera del período del último lote consolidado', async () => {
      const svc = servicio({
        lotes: {
          exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
          obtenerUltimoConsolidado: jest.fn(() =>
            Promise.resolve({
              periodoDesde: new Date('2026-08-01'),
              periodoHasta: new Date('2026-08-31'),
            }),
          ),
        },
      });

      await expect(
        svc.crear(CUENTA.toString(), {
          codigo: 'ND',
          inmuebleId: INMUEBLE.toString(),
          conceptoId: CONCEPTO.toString(),
          motivo: 'otro',
          total: 50000,
          fechaCargo: '2026-09-01',
          fechaVencimiento: '2026-09-30',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('deja pasar una fecha de cargo dentro del período del último lote consolidado', async () => {
      const svc = servicio({
        lotes: {
          exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
          obtenerUltimoConsolidado: jest.fn(() =>
            Promise.resolve({
              periodoDesde: new Date('2026-08-01'),
              periodoHasta: new Date('2026-08-31'),
            }),
          ),
        },
      });

      await expect(
        svc.crear(CUENTA.toString(), {
          codigo: 'ND',
          inmuebleId: INMUEBLE.toString(),
          conceptoId: CONCEPTO.toString(),
          motivo: 'otro',
          total: 50000,
          fechaCargo: '2026-08-15',
          fechaVencimiento: '2026-09-15',
        }),
      ).resolves.toBeDefined();
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
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
    });

    it('al anular, reversa la cuenta de INGRESO del concepto, no la cuenta compartida de la copropiedad (bug real reportado, 2026-09-21)', async () => {
      // `cuentaNotasDebito` y `cuentaCreditoId.codigo` valen distinto a
      // propósito — un test que usara el mismo valor para ambos (como el
      // resto de este archivo) no puede distinguir cuál de las dos se usó
      // de verdad, y así fue como este bug pasó sin verse.
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'administracion',
                cuentaCreditoId: { codigo: '413501-CONCEPTO' },
              }),
            ),
          })),
        },
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '413599-COPROPIEDAD',
              }),
            ),
          })),
        },
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'error_digitacion',
          detalle: 'Se anula por error en digitación del cargo',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string }> }[]],
      ];
      const cuentas = documentos[0].movimientos.map((e) => e.cuenta);
      expect(cuentas).toContain('413501-CONCEPTO');
      expect(cuentas).not.toContain('413599-COPROPIEDAD');
    });

    it('al anular sin cuentaCreditoId configurada en el concepto, cae a SIN-CUENTA-ASIGNADA (no a la cuenta compartida de la copropiedad)', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'administracion',
                cuentaCreditoId: null,
              }),
            ),
          })),
        },
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '413599-COPROPIEDAD',
              }),
            ),
          })),
        },
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'error_digitacion',
          detalle: 'Se anula por error en digitación del cargo',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string }> }[]],
      ];
      const cuentas = documentos[0].movimientos.map((e) => e.cuenta);
      expect(cuentas).toContain('SIN-CUENTA-ASIGNADA');
      expect(cuentas).not.toContain('413599-COPROPIEDAD');
    });

    it('al anular, NO mueve cuentas de orden cuando el concepto de la nota no es intereses', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'administracion',
                cuentaCreditoId: { codigo: '4105' },
              }),
            ),
          })),
        },
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '4105',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
            ),
          })),
        },
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'error_digitacion',
          detalle: 'Se anula por error en digitación del cargo',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string }> }[]],
      ];
      const cuentas = documentos[0].movimientos.map((e) => e.cuenta);
      expect(cuentas).not.toContain('831505');
      expect(cuentas).not.toContain('831510');
    });

    it('al anular, revierte cuentas de orden cuando el concepto de la nota SÍ es intereses', async () => {
      const asientos = { create: jest.fn(() => Promise.resolve([{}])) };
      const svc = servicio({
        asientos,
        conceptos: {
          findOne: jest.fn(() => ({
            populate: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                _id: CONCEPTO,
                copropiedadId: COP,
                tipo: 'intereses',
                cuentaCreditoId: { codigo: '413599' },
              }),
            ),
          })),
        },
        copropiedades: {
          findById: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve({
                cuentaContableCartera: '1305',
                cuentaNotasDebito: '4105',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
            ),
          })),
        },
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'error_digitacion',
          detalle: 'Se anula por error en digitación del cargo',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      const [[documentos]] = asientos.create.mock.calls as unknown as [
        [{ movimientos: Array<{ cuenta: string; monto: number }> }[]],
      ];
      const memo = documentos[0].movimientos.find(
        (e) => e.cuenta === '831505' || e.cuenta === '831510',
      );
      expect(memo?.monto).toBe(50000);
    });

    it('anula nota débito con aplicaciones activas, restaurando fuentes RC', async () => {
      const aplicacion = {
        _id: new Types.ObjectId(),
        sourceType: 'RC',
        sourceId: new Types.ObjectId(),
        tipoDocumento: 'ND',
        documentoId: new Types.ObjectId(),
        montoAplicado: 20000,
        estado: 'activa',
      };
      const saldoDocumentoOrigenFindOneAndUpdate = jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve({ saldoDisponible: 20000 })),
      }));
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
        saldoDocumentoOrigen: {
          findOneAndUpdate: saldoDocumentoOrigenFindOneAndUpdate,
        },
      });

      const resultado = await svc.anular(
        'test-id',
        {
          motivo: 'otro',
          detalle: 'Se anula porque el cargo fue generado por error',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
      // El monto restaurado tiene que ser EXACTAMENTE el que la aplicación
      // había descontado (20000) — no un valor cualquiera, ni el campo
      // equivocado. Un bug en el monto/signo no lo habría detectado el test
      // anterior, que solo miraba `estado`.
      expect(saldoDocumentoOrigenFindOneAndUpdate).toHaveBeenCalledWith(
        { documentoId: aplicacion.sourceId },
        { $inc: { saldoDisponible: 20000 } },
        expect.anything(),
      );
    });

    it('anula nota débito con aplicaciones activas, restaurando fuentes NC', async () => {
      const aplicacion = {
        _id: new Types.ObjectId(),
        sourceType: 'NC',
        sourceId: new Types.ObjectId(),
        tipoDocumento: 'ND',
        documentoId: new Types.ObjectId(),
        montoAplicado: 30000,
        estado: 'activa',
      };
      const saldoDocumentoOrigenFindOneAndUpdate = jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve({ saldoDisponible: 30000 })),
      }));
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
        saldoDocumentoOrigen: {
          findOneAndUpdate: saldoDocumentoOrigenFindOneAndUpdate,
        },
      });

      const resultado = await svc.anular(
        'test-id',
        {
          motivo: 'error_facturacion',
          detalle: 'La nota débito fue emitida por error de facturación',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
      expect(saldoDocumentoOrigenFindOneAndUpdate).toHaveBeenCalledWith(
        { documentoId: aplicacion.sourceId },
        { $inc: { saldoDisponible: 30000 } },
        expect.anything(),
      );
    });

    it('anula nota débito con aplicación activa de una Nota de Anticipo, restaurando el Recibo de origen', async () => {
      // Una Nota de Anticipo no tiene saldo propio (ver su schema) — deshacer
      // su aplicación reduce SU propio montoAplicado y devuelve el dinero al
      // Recibo del que salió, no a la Nota de Anticipo misma.
      const reciboOrigenId = new Types.ObjectId();
      const notaAnticipoId = new Types.ObjectId();
      const aplicacion = {
        _id: new Types.ObjectId(),
        sourceType: 'NA',
        sourceId: notaAnticipoId,
        tipoDocumento: 'ND',
        documentoId: new Types.ObjectId(),
        montoAplicado: 40000,
        estado: 'activa',
      };
      const notasAnticipoFindOneAndUpdate = jest.fn(() => ({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn(() =>
          Promise.resolve({ _id: notaAnticipoId, reciboOrigenId }),
        ),
      }));
      const saldoDocumentoOrigenFindOneAndUpdate = jest.fn(() => ({
        exec: jest.fn(() => Promise.resolve({ saldoDisponible: 40000 })),
      }));
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
        notasAnticipo: { findOneAndUpdate: notasAnticipoFindOneAndUpdate },
        saldoDocumentoOrigen: {
          findOneAndUpdate: saldoDocumentoOrigenFindOneAndUpdate,
        },
      });

      const resultado = await svc.anular(
        'test-id',
        {
          motivo: 'error_facturacion',
          detalle: 'La nota débito fue emitida por error de facturación',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      expect(resultado.estado).toBe('anulada');
      expect(notasAnticipoFindOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: notaAnticipoId }),
        expect.objectContaining({ $inc: { montoAplicado: -40000 } }),
        expect.anything(),
      );
      expect(saldoDocumentoOrigenFindOneAndUpdate).toHaveBeenCalledWith(
        { documentoId: reciboOrigenId },
        { $inc: { saldoDisponible: 40000 } },
        expect.anything(),
      );
    });

    it('no restaura fuentes cuya aplicación ya fue revertida (edge case)', async () => {
      const aplicacionRevertida = {
        _id: new Types.ObjectId(),
        sourceType: 'RC',
        sourceId: new Types.ObjectId(),
        tipoDocumento: 'ND',
        documentoId: new Types.ObjectId(),
        montoAplicado: 10000,
        estado: 'revertida',
      };
      const saldoDocumentoOrigen = {
        findOneAndUpdate: jest.fn(() => ({
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
                filtro.estado === 'activa' ? [] : [aplicacionRevertida],
              ),
            ),
          })),
          findOneAndUpdate: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({})),
          })),
        },
        saldoDocumentoOrigen,
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'duplicado',
          detalle: 'Se anula la nota débito duplicada generada por error',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      expect(saldoDocumentoOrigen.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('falla si la nota débito ya está anulada', async () => {
      const svc = servicio({
        notasDebito: {
          create: jest.fn(),
          find: jest.fn(),
          findOne: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() =>
              Promise.resolve(notaDebitoDoc({ estado: 'anulada' })),
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
            fecha: '2026-09-05',
          },
          CUENTA.toString(),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('revierte SaldoCartera por el saldo PENDIENTE actual, no por el total original de la nota', async () => {
      // Regresión: `nota.saldoPendiente` es un campo congelado desde
      // que `SaldoTotalDocumento` se volvió la fuente viva (ver su propio
      // docblock) — leerlo directo de `nota` siempre habría dado el total
      // original, sin importar cuánto de la nota ya se hubiera pagado antes
      // de anularla. Esta nota tiene total 50000 pero solo 20000 siguen
      // pendientes (30000 ya se aplicaron vía un Recibo, sin relación con
      // esta anulación) — el ajuste a SaldoCartera debe ser por 20000.
      const llamadasSaldos: unknown[][] = [];
      const svc = servicio({
        saldoTotalDocumento: {
          create: jest.fn(() => Promise.resolve([{}])),
          updateOne: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({})),
          })),
          findOne: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve({ saldoPendiente: 20000 })),
          })),
        },
        saldos: {
          findOne: jest.fn(() => ({
            session: jest.fn().mockReturnThis(),
            exec: jest.fn(() => Promise.resolve(null)),
          })),
          findOneAndUpdate: jest.fn((...args: unknown[]) => {
            llamadasSaldos.push(args);
            return {
              session: jest.fn().mockReturnThis(),
              exec: jest.fn(() => Promise.resolve({})),
            };
          }),
        },
      });

      await svc.anular(
        'test-id',
        {
          motivo: 'otro',
          detalle: 'Se anula tras haberse pagado parcialmente antes',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      );

      expect(llamadasSaldos).toHaveLength(1);
      const [, pipeline] = llamadasSaldos[0] as [
        unknown,
        [
          {
            $set: {
              saldoPendiente: { $max: [number, { $add: [string, number] }] };
            };
          },
        ],
      ];
      expect(pipeline[0].$set.saldoPendiente.$max[1].$add[1]).toBe(-20000);
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
