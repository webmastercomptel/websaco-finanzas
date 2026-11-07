import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { NotificacionesService } from './notificaciones.service';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const NOTA = new Types.ObjectId();

const exec = <T>(valor: T) => ({ exec: () => Promise.resolve(valor) });

/** `null` = a signed-in person with no local account (an omitted argument means CUENTA). */
const usuario = (accountId: string | null = CUENTA.toString()) =>
  ({
    accountId: accountId ?? undefined,
    email: 'a@b.co',
  }) as unknown as IRequestUser;

function documento(extra: Record<string, unknown> = {}) {
  return {
    _id: NOTA,
    tipo: 'pqr',
    titulo: 'Nueva PQR',
    descripcion: 'Detalle',
    leida: false,
    createdAt: new Date('2026-03-04T05:06:07Z'),
    ...extra,
  };
}

function crear(
  opciones: {
    encontrada?: unknown;
    lista?: unknown[];
    fallaAlGuardar?: boolean;
  } = {},
) {
  const limit = jest.fn().mockReturnValue(exec(opciones.lista ?? []));
  const sort = jest.fn().mockReturnValue({ limit });
  const modelo = {
    find: jest.fn().mockReturnValue({ sort }),
    findOneAndUpdate: jest.fn().mockReturnValue(exec(opciones.encontrada)),
    updateMany: jest.fn().mockReturnValue(exec({ modifiedCount: 4 })),
    create: jest
      .fn()
      .mockImplementation(() =>
        opciones.fallaAlGuardar
          ? Promise.reject(new Error('sin base'))
          : Promise.resolve({}),
      ),
  };
  const tenant = { resolveCoPropertyId: jest.fn().mockReturnValue(COP) };
  return {
    servicio: new NotificacionesService(modelo as never, tenant as never),
    modelo,
    sort,
    limit,
  };
}

describe('NotificacionesService.findAll', () => {
  it('lista solo la bandeja de ESTA cuenta en la copropiedad activa, la más nueva primero y acotada', async () => {
    const { servicio, modelo, sort, limit } = crear({ lista: [documento()] });

    const lista = await servicio.findAll(usuario());

    expect(modelo.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      accountId: new Types.ObjectId(CUENTA.toString()),
    });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(100);
    expect(lista).toEqual([
      {
        id: NOTA.toString(),
        tipo: 'pqr',
        titulo: 'Nueva PQR',
        descripcion: 'Detalle',
        fecha: '2026-03-04T05:06:07.000Z',
        leida: false,
      },
    ]);
  });

  it('sin cuenta local devuelve vacío sin consultar', async () => {
    const { servicio, modelo } = crear();

    await expect(servicio.findAll(usuario(null))).resolves.toEqual([]);
    expect(modelo.find).not.toHaveBeenCalled();
  });
});

describe('NotificacionesService.marcarLeida', () => {
  it('marca una notificación propia de la copropiedad activa', async () => {
    const { servicio, modelo } = crear({
      encontrada: documento({ leida: true }),
    });

    const nota = await servicio.marcarLeida(NOTA.toString(), usuario());

    expect(modelo.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: NOTA.toString(),
        copropiedadId: COP,
        accountId: new Types.ObjectId(CUENTA.toString()),
      },
      { leida: true },
      { new: true },
    );
    expect(nota.leida).toBe(true);
  });

  it('la de otra cuenta, de otra copropiedad o un id mal formado es 404', async () => {
    const ajena = crear({ encontrada: null });
    const malFormada = crear();

    await expect(
      ajena.servicio.marcarLeida(NOTA.toString(), usuario()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      malFormada.servicio.marcarLeida('x', usuario()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(malFormada.modelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('sin cuenta local es 404', async () => {
    const { servicio } = crear();

    await expect(
      servicio.marcarLeida(NOTA.toString(), usuario(null)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NotificacionesService.marcarTodasLeidas', () => {
  it('actualiza solo las no leídas de esta cuenta en la copropiedad activa', async () => {
    const { servicio, modelo } = crear();

    await expect(servicio.marcarTodasLeidas(usuario())).resolves.toEqual({
      actualizadas: 4,
    });
    expect(modelo.updateMany).toHaveBeenCalledWith(
      {
        copropiedadId: COP,
        accountId: new Types.ObjectId(CUENTA.toString()),
        leida: false,
      },
      { leida: true },
    );
  });

  it('sin cuenta local no actualiza nada', async () => {
    const { servicio, modelo } = crear();

    await expect(servicio.marcarTodasLeidas(usuario(null))).resolves.toEqual({
      actualizadas: 0,
    });
    expect(modelo.updateMany).not.toHaveBeenCalled();
  });
});

describe('NotificacionesService.crear (productor)', () => {
  it('guarda la notificación como no leída, con descripción vacía por defecto', async () => {
    const { servicio, modelo } = crear();

    await servicio.crear({
      copropiedadId: COP,
      accountId: CUENTA,
      tipo: 'tarea',
      titulo: 'Tarea asignada',
    });

    expect(modelo.create).toHaveBeenCalledWith({
      copropiedadId: COP,
      accountId: CUENTA,
      tipo: 'tarea',
      titulo: 'Tarea asignada',
      descripcion: '',
      leida: false,
    });
  });

  it('nunca lanza: un fallo al guardar no rompe a quien la produce', async () => {
    const { servicio } = crear({ fallaAlGuardar: true });

    await expect(
      servicio.crear({
        copropiedadId: COP,
        accountId: CUENTA,
        tipo: 'tarea',
        titulo: 'x',
      }),
    ).resolves.toBeUndefined();
  });
});
