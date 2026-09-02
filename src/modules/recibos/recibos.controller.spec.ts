import { Types } from 'mongoose';
import { RecibosController } from './recibos.controller';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const COP = new Types.ObjectId();

function makeController(
  recibos: Record<string, unknown>,
  copropiedades: Record<string, unknown> = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: 'COP-1', name: 'Copropiedad Test' }),
    })),
  },
) {
  return new RecibosController(
    recibos as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    copropiedades as never,
  );
}

describe('RecibosController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const recibos = { crear: jest.fn(() => Promise.resolve({ id: 'rec-1' })) };
    const controller = makeController(recibos);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      inmuebleId: new Types.ObjectId().toString(),
      terceroId: new Types.ObjectId().toString(),
      montoRecibido: 100000,
      fechaRecibo: '2026-08-27',
      medioPago: 'efectivo',
      cuentaDestino: 'caja-1',
    });

    expect(recibos.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('RecibosController.aplicar', () => {
  it('delega en el servicio con el id de ruta y el accountId del caller', async () => {
    const recibos = {
      aplicar: jest.fn(() =>
        Promise.resolve({ aplicadas: [], montoSinAplicar: 0, errores: [] }),
      ),
    };
    const controller = makeController(recibos);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.aplicar(user, 'rec-1', { aplicacionAutomatica: true });

    expect(recibos.aplicar).toHaveBeenCalledWith(
      'rec-1',
      { aplicacionAutomatica: true },
      user.accountId,
    );
  });
});

describe('RecibosController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const recibos = {
      anular: jest.fn(() =>
        Promise.resolve({ id: 'rec-1', estado: 'anulado' }),
      ),
    };
    const controller = makeController(recibos);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'rec-1', dto);

    // Anular es la operación más sensible del módulo (motivo obligatorio +
    // justificación de 20 caracteres, y cascada sobre cada aplicación): el
    // actor sale del caller autenticado, nunca del body.
    expect(recibos.anular).toHaveBeenCalledWith('rec-1', dto, user.accountId);
  });
});

describe('RecibosController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const recibos = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(recibos);

    await controller.findAll({ estado: 'activo' });

    expect(recibos.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio', async () => {
    const recibos = {
      findOne: jest.fn(() => Promise.resolve({ id: 'rec-1' })),
    };
    const controller = makeController(recibos);

    await controller.findOne('rec-1');

    expect(recibos.findOne).toHaveBeenCalledWith('rec-1');
  });
});

describe('RecibosController.generarPdf', () => {
  it('responde con Content-Type application/pdf y bytes reales', async () => {
    const recibos = {
      findOneRaw: jest.fn(() =>
        Promise.resolve({
          _id: new Types.ObjectId(),
          fullNumber: 'RC-001-0001',
          receivedDate: new Date('2026-08-05'),
          receivedAmount: 100000,
          paymentMethod: 'efectivo',
          destinationAccount: 'caja-1',
          reference: null,
          notes: null,
          appliedAmount: 100000,
          unappliedAmount: 0,
        }),
      ),
      findAplicacionesForSource: jest.fn(() => Promise.resolve([])),
    };
    const controller = makeController(recibos);
    const set = jest.fn();
    const send = jest.fn();
    const res = { set, send } as never;

    await controller.generarPdf('rec-1', undefined, res);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'application/pdf' }),
    );
    const bytes = (send.mock.calls[0] as [Buffer])[0];
    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('propaga duplicado=true al generador de PDF', async () => {
    const recibos = {
      findOneRaw: jest.fn(() =>
        Promise.resolve({
          _id: new Types.ObjectId(),
          fullNumber: 'RC-001-0001',
          receivedDate: new Date('2026-08-05'),
          receivedAmount: 100000,
          paymentMethod: 'efectivo',
          destinationAccount: 'caja-1',
          reference: null,
          notes: null,
          appliedAmount: 100000,
          unappliedAmount: 0,
        }),
      ),
      findAplicacionesForSource: jest.fn(() => Promise.resolve([])),
    };
    const controller = makeController(recibos);
    const sinDuplicado = { set: jest.fn(), send: jest.fn() } as never;
    const conDuplicado = { set: jest.fn(), send: jest.fn() } as never;

    await controller.generarPdf('rec-1', undefined, sinDuplicado);
    await controller.generarPdf('rec-1', 'true', conDuplicado);

    const bytesSin = (
      (sinDuplicado as unknown as { send: jest.Mock }).send.mock.calls[0] as [
        Buffer,
      ]
    )[0];
    const bytesCon = (
      (conDuplicado as unknown as { send: jest.Mock }).send.mock.calls[0] as [
        Buffer,
      ]
    )[0];
    expect(bytesCon.length).toBeGreaterThan(bytesSin.length);
  });
});
