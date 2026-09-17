import { Types } from 'mongoose';
import { NotasAnticipoController } from './notas-anticipo.controller';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const COP = new Types.ObjectId();

function makeController(
  notasAnticipo: Record<string, unknown>,
  copropiedades: Record<string, unknown> = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: 'COP-1', name: 'Copropiedad Test' }),
    })),
  },
) {
  // `facturas`/`notasDebito`/`recibos`/`inmuebles`/`terceros`/
  // `cuentasContables` back `construirDatosImpresionNotaAnticipo`
  // (`generarPdf`'s own assembly step) — every test here that never calls
  // `generarPdf` never touches them, so an empty-result stub is enough.
  const facturas = {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };
  const notasDebito = {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };
  const recibos = {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };
  const saldosInicialesAnticipo = {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };
  const inmuebles = {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };
  const terceros = {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };
  const cuentasContables = {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };

  return new NotasAnticipoController(
    notasAnticipo as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    copropiedades as never,
    facturas as never,
    notasDebito as never,
    recibos as never,
    saldosInicialesAnticipo as never,
    inmuebles as never,
    terceros as never,
    cuentasContables as never,
  );
}

describe('NotasAnticipoController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasAnticipo = {
      crear: jest.fn(() => Promise.resolve({ id: 'na-1' })),
    };
    const controller = makeController(notasAnticipo);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      codigo: 'NA',
      reciboOrigenId: new Types.ObjectId().toString(),
      fechaEmision: '2026-09-01',
      aplicacionAutomatica: true,
    });

    expect(notasAnticipo.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('NotasAnticipoController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasAnticipo = {
      anular: jest.fn(() => Promise.resolve({ id: 'na-1', estado: 'anulado' })),
    };
    const controller = makeController(notasAnticipo);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres para la anulación',
      fecha: '2026-09-05',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'na-1', dto);

    expect(notasAnticipo.anular).toHaveBeenCalledWith(
      'na-1',
      dto,
      user.accountId,
    );
  });
});

describe('NotasAnticipoController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const notasAnticipo = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(notasAnticipo);

    await controller.findAll({ estado: 'activo' });

    expect(notasAnticipo.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio', async () => {
    const notasAnticipo = {
      findOne: jest.fn(() => Promise.resolve({ id: 'na-1' })),
    };
    const controller = makeController(notasAnticipo);

    await controller.findOne('na-1');

    expect(notasAnticipo.findOne).toHaveBeenCalledWith('na-1');
  });
});

describe('NotasAnticipoController.generarPdf', () => {
  const notaFixture = () => ({
    _id: new Types.ObjectId(),
    inmuebleId: new Types.ObjectId(),
    terceroId: new Types.ObjectId(),
    reciboOrigenId: new Types.ObjectId(),
    fullNumber: 'NA-001-0001',
    issueDate: new Date('2026-08-10'),
    appliedAmount: 100000,
  });

  it('responde con Content-Type application/pdf y bytes reales', async () => {
    const notasAnticipo = {
      findOneRaw: jest.fn(() => Promise.resolve(notaFixture())),
      findAplicaciones: jest.fn(() => Promise.resolve([])),
    };
    const controller = makeController(notasAnticipo);
    const set = jest.fn();
    const send = jest.fn();

    await controller.generarPdf('na-1', undefined, { set, send } as never);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'application/pdf' }),
    );
    const bytes = (send.mock.calls[0] as [Buffer])[0];
    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});
