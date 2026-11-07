import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { UnidadPortal } from '../portal/portal-acceso.service';
import { PqrService } from './pqr.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  sort: jest.Mock;
  populate: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.sort = jest.fn().mockReturnValue(q);
  q.populate = jest.fn().mockReturnValue(q);
  return q;
};

type ModeloPqr = jest.Mock & {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const PQR = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const TECNICO = new Types.ObjectId();

const pqrDoc = (extra: Record<string, unknown> = {}) => ({
  _id: PQR,
  copropiedadId: COPROPIEDAD,
  autorId: CUENTA,
  codigo: 'PQR-001',
  titulo: 'Filtración',
  descripcion: 'Resumen',
  descripcionCompleta: 'Detalle',
  categoria: '',
  tipo: 'reclamos',
  estado: 'pendiente',
  prioridad: 'normal',
  unidad: 'A-101',
  residente: { nombre: 'Juan Pérez', rol: 'Propietario' },
  archivosAdjuntos: [],
  seguimientos: [],
  tecnicoId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...extra,
});

const staff: IRequestUser = {
  uid: 'u-staff',
  email: 's@x.co',
  nombre: 'Ana Admin',
  accountId: new Types.ObjectId().toString(),
};

const residente: IRequestUser = {
  uid: 'u-res',
  email: 'r@x.co',
  nombre: 'Juan Pérez',
  accountId: CUENTA.toString(),
  esResidente: true,
};

const unidad = (
  codigo: string,
  rol: UnidadPortal['rol'] = 'propietario',
): UnidadPortal => ({
  inmuebleId: new Types.ObjectId().toString(),
  codigo,
  rol,
});

function montar(unidades: UnidadPortal[] = [unidad('A-101')]) {
  const pqrs = jest.fn().mockImplementation((doc: Record<string, unknown>) => {
    const instancia: Record<string, unknown> = { ...doc, _id: PQR };
    instancia.save = jest.fn().mockResolvedValue(instancia);
    return instancia;
  }) as ModeloPqr;
  pqrs.find = jest.fn().mockReturnValue(consulta([pqrDoc()]));
  pqrs.findOne = jest.fn().mockReturnValue(consulta(pqrDoc()));
  pqrs.findOneAndUpdate = jest.fn().mockReturnValue(consulta(pqrDoc()));

  const tecnicos = {
    findOne: jest.fn().mockReturnValue(consulta({ _id: TECNICO })),
  };
  const consecutivos = {
    findOneAndUpdate: jest.fn().mockReturnValue(consulta({ valor: 1 })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const portalAcceso = {
    unidadesDe: jest
      .fn<Promise<UnidadPortal[]>, [string, string]>()
      .mockResolvedValue(unidades),
  };
  const notificaciones = {
    notificarNueva: jest.fn().mockResolvedValue(undefined),
    notificarRespuesta: jest.fn().mockResolvedValue(undefined),
  };

  const servicio = new PqrService(
    pqrs as never,
    tecnicos as never,
    consecutivos as never,
    tenant as never,
    portalAcceso as never,
    notificaciones as never,
  );
  return {
    servicio,
    pqrs,
    tecnicos,
    consecutivos,
    portalAcceso,
    notificaciones,
  };
}

describe('PqrService — personal: crear', () => {
  const dto = {
    titulo: 'Filtración',
    descripcion: 'Resumen',
    tipo: 'reclamos' as const,
    unidad: 'B-2',
    residenteNombre: 'Marta',
    residenteRol: 'Arrendatario',
  };

  it('crea con el código PQR-001 de la secuencia, la copropiedad del contexto y sin autor', async () => {
    const { servicio, pqrs, consecutivos } = montar();

    await servicio.crear(dto, staff);

    expect(consecutivos.findOneAndUpdate).toHaveBeenCalledWith(
      { clave: 'PQR' },
      { $inc: { valor: 1 } },
      { upsert: true, new: true },
    );
    expect(pqrs).toHaveBeenCalledWith(
      expect.objectContaining({
        codigo: 'PQR-001',
        copropiedadId: COPROPIEDAD,
        autorId: null,
        unidad: 'B-2',
        residente: { nombre: 'Marta', rol: 'Arrendatario' },
      }),
    );
  });

  it('avisa al personal que puede leerla, saltando a quien la registró', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.crear(dto, staff);

    expect(notificaciones.notificarNueva).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: 'PQR-001' }),
      COPROPIEDAD,
      staff.accountId,
    );
  });

  it('devuelve el contrato (con el nombre del técnico poblado dentro de la copropiedad)', async () => {
    const { servicio, pqrs } = montar();

    const contrato = await servicio.crear(dto, staff);

    expect(contrato.codigo).toBe('PQR-001');
    const poblado = (pqrs.findOne.mock.results[0].value as Consulta).populate;
    expect(poblado).toHaveBeenCalledWith({
      path: 'tecnicoId',
      select: 'nombre',
      match: { copropiedadId: COPROPIEDAD },
    });
  });
});

describe('PqrService — personal: listar y obtener', () => {
  it('lista TODAS las de la copropiedad activa (sin filtro de autor), nuevas primero', async () => {
    const { servicio, pqrs } = montar();

    await servicio.listar({});

    expect(pqrs.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
    expect(
      (pqrs.find.mock.results[0].value as Consulta).sort,
    ).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('aplica tipo y estado, y todos no filtra', async () => {
    const { servicio, pqrs } = montar();

    await servicio.listar({ tipo: 'quejas', estado: 'resuelto' });
    await servicio.listar({ tipo: 'todos', estado: 'todos' });

    expect(pqrs.find).toHaveBeenNthCalledWith(1, {
      copropiedadId: COPROPIEDAD,
      tipo: 'quejas',
      estado: 'resuelto',
    });
    expect(pqrs.find).toHaveBeenNthCalledWith(2, {
      copropiedadId: COPROPIEDAD,
    });
  });

  it('obtiene por id Y copropiedad', async () => {
    const { servicio, pqrs } = montar();

    const contrato = await servicio.obtener(PQR.toString());

    expect(contrato.id).toBe(PQR.toString());
    expect(pqrs.findOne).toHaveBeenCalledWith({
      _id: PQR.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('responde 404 si no existe en esta copropiedad y no toca la base con un id mal formado', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(servicio.obtener(PQR.toString())).rejects.toThrow(
      NotFoundException,
    );
    pqrs.findOne.mockClear();
    await expect(servicio.obtener('no-es-un-id')).rejects.toThrow(
      NotFoundException,
    );
    expect(pqrs.findOne).not.toHaveBeenCalled();
  });
});

describe('PqrService — personal: actualizar', () => {
  it('escribe solo lo enviado, de forma atómica y por id Y copropiedad', async () => {
    const { servicio, pqrs } = montar();

    await servicio.actualizar(PQR.toString(), { estado: 'resuelto' });

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PQR.toString(), copropiedadId: COPROPIEDAD },
      { $set: { estado: 'resuelto' } },
      { new: true },
    );
  });

  it('normaliza la prioridad heredada urgente a alta', async () => {
    const { servicio, pqrs } = montar();

    await servicio.actualizar(PQR.toString(), { prioridad: 'urgente' });

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { prioridad: 'alta' } },
      expect.anything(),
    );
  });

  it('solo asigna un técnico de la copropiedad activa', async () => {
    const { servicio, pqrs, tecnicos } = montar();

    await servicio.actualizar(PQR.toString(), {
      tecnicoId: TECNICO.toString(),
    });

    expect(tecnicos.findOne).toHaveBeenCalledWith({
      _id: TECNICO.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { tecnicoId: TECNICO } },
      expect.anything(),
    );
  });

  it('un técnico de otro edificio (o inexistente) es 404 y no se escribe nada', async () => {
    const { servicio, pqrs, tecnicos } = montar();
    tecnicos.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(PQR.toString(), {
        tecnicoId: new Types.ObjectId().toString(),
      }),
    ).rejects.toThrow(NotFoundException);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un tecnicoId mal formado es 404 sin consultar técnicos', async () => {
    const { servicio, tecnicos } = montar();

    await expect(
      servicio.actualizar(PQR.toString(), { tecnicoId: 'xyz' }),
    ).rejects.toThrow(NotFoundException);
    expect(tecnicos.findOne).not.toHaveBeenCalled();
  });

  it('tecnicoId null desasigna', async () => {
    const { servicio, pqrs } = montar();

    await servicio.actualizar(PQR.toString(), { tecnicoId: null });

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { tecnicoId: null } },
      expect.anything(),
    );
  });

  it('un cuerpo vacío no escribe: solo devuelve la PQR', async () => {
    const { servicio, pqrs } = montar();

    const contrato = await servicio.actualizar(PQR.toString(), {});

    expect(contrato.id).toBe(PQR.toString());
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('404 si la PQR no existe en la copropiedad, y con id mal formado sin tocar la base', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(PQR.toString(), { estado: 'resuelto' }),
    ).rejects.toThrow(NotFoundException);
    pqrs.findOneAndUpdate.mockClear();
    await expect(
      servicio.actualizar('mal', { estado: 'resuelto' }),
    ).rejects.toThrow(NotFoundException);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('PqrService — personal: responder', () => {
  it('agrega el seguimiento con un solo $push, firmado con el nombre de la cuenta', async () => {
    const { servicio, pqrs } = montar();

    await servicio.responder(PQR.toString(), { mensaje: 'Ya vamos' }, staff);

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PQR.toString(), copropiedadId: COPROPIEDAD },
      {
        $push: {
          seguimientos: {
            autor: 'Ana Admin',
            mensaje: 'Ya vamos',
            fecha: expect.any(Date) as Date,
          },
        },
      },
      { new: true },
    );
  });

  it('sin nombre en la cuenta firma como Usuario', async () => {
    const { servicio, pqrs } = montar();

    await servicio.responder(
      PQR.toString(),
      { mensaje: 'x' },
      { ...staff, nombre: undefined },
    );

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      {
        $push: {
          seguimientos: expect.objectContaining({ autor: 'Usuario' }) as object,
        },
      },
      expect.anything(),
    );
  });

  it('avisa a la autora indicando quién escribió', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.responder(PQR.toString(), { mensaje: 'Ya vamos' }, staff);

    expect(notificaciones.notificarRespuesta).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: 'PQR-001' }),
      COPROPIEDAD,
      { accountId: staff.accountId, nombre: 'Ana Admin' },
      'Ya vamos',
    );
  });

  it('404 si la PQR no existe en la copropiedad: no avisa a nadie', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.responder(PQR.toString(), { mensaje: 'x' }, staff),
    ).rejects.toThrow(NotFoundException);
    expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
  });
});

describe('PqrService — residente: crearComoResidente', () => {
  const dto = {
    titulo: 'Ruido',
    descripcion: 'Fiesta',
    tipo: 'quejas' as const,
  };

  it('una unidad que no es suya es 403 y no se crea ni se avisa nada', async () => {
    const { servicio, pqrs, notificaciones } = montar([unidad('A-101')]);

    await expect(
      servicio.crearComoResidente({ ...dto, unidad: 'Z-999' }, residente),
    ).rejects.toThrow(ForbiddenException);
    expect(pqrs).not.toHaveBeenCalled();
    expect(notificaciones.notificarNueva).not.toHaveBeenCalled();
  });

  it('con una unidad propia guarda el código de la unidad, el nombre de la cuenta y el rol que tiene en ella', async () => {
    const { servicio, pqrs, portalAcceso } = montar([
      unidad('A-101', 'propietario'),
      unidad('B-2', 'arrendatario'),
    ]);

    await servicio.crearComoResidente({ ...dto, unidad: 'B-2' }, residente);

    expect(portalAcceso.unidadesDe).toHaveBeenCalledWith(
      CUENTA.toString(),
      COPROPIEDAD.toString(),
    );
    expect(pqrs).toHaveBeenCalledWith(
      expect.objectContaining({
        codigo: 'PQR-001',
        copropiedadId: COPROPIEDAD,
        autorId: CUENTA,
        estado: 'pendiente',
        unidad: 'B-2',
        residente: { nombre: 'Juan Pérez', rol: 'Arrendatario' },
      }),
    );
  });

  it('compara la unidad sin distinguir mayúsculas y guarda el código tal como está en el catálogo', async () => {
    const { servicio, pqrs } = montar([unidad('A-101')]);

    await servicio.crearComoResidente({ ...dto, unidad: ' a-101 ' }, residente);

    expect(pqrs).toHaveBeenCalledWith(
      expect.objectContaining({ unidad: 'A-101' }),
    );
  });

  it('si tiene una sola unidad puede omitirla', async () => {
    const { servicio, pqrs } = montar([unidad('A-101')]);

    await servicio.crearComoResidente(dto, residente);

    expect(pqrs).toHaveBeenCalledWith(
      expect.objectContaining({ unidad: 'A-101' }),
    );
  });

  it('con varias unidades omitirla es 400 (no se adivina)', async () => {
    const { servicio, pqrs } = montar([unidad('A-101'), unidad('B-2')]);

    await expect(servicio.crearComoResidente(dto, residente)).rejects.toThrow(
      BadRequestException,
    );
    expect(pqrs).not.toHaveBeenCalled();
  });

  it('sin unidades en la copropiedad es 400', async () => {
    const { servicio } = montar([]);

    await expect(servicio.crearComoResidente(dto, residente)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('avisa al personal saltando a la propia residente', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.crearComoResidente(dto, residente);

    expect(notificaciones.notificarNueva).toHaveBeenCalledWith(
      expect.anything(),
      COPROPIEDAD,
      CUENTA.toString(),
    );
  });

  it('sin una cuenta utilizable es 403 antes de consultar nada', async () => {
    const { servicio, portalAcceso } = montar();

    await expect(
      servicio.crearComoResidente(dto, { ...residente, accountId: undefined }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      servicio.crearComoResidente(dto, { ...residente, accountId: 'xx' }),
    ).rejects.toThrow(ForbiddenException);
    expect(portalAcceso.unidadesDe).not.toHaveBeenCalled();
  });
});

describe('PqrService — residente: solo ve y toca lo suyo', () => {
  it('listarPropias filtra por la autoría de la cuenta además de la copropiedad', async () => {
    const { servicio, pqrs } = montar();

    await servicio.listarPropias({ tipo: 'quejas' }, residente);

    expect(pqrs.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      autorId: CUENTA,
      tipo: 'quejas',
    });
  });

  it('obtenerPropia busca por id, copropiedad Y autoría', async () => {
    const { servicio, pqrs } = montar();

    await servicio.obtenerPropia(PQR.toString(), residente);

    expect(pqrs.findOne).toHaveBeenCalledWith({
      _id: PQR.toString(),
      copropiedadId: COPROPIEDAD,
      autorId: CUENTA,
    });
  });

  it('la PQR de otra persona es 404, igual que una que no existe', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.obtenerPropia(PQR.toString(), residente),
    ).rejects.toThrow(NotFoundException);
  });

  it('responderPropia escribe solo si la PQR es suya (autoría dentro del filtro de escritura)', async () => {
    const { servicio, pqrs } = montar();

    await servicio.responderPropia(
      PQR.toString(),
      { mensaje: 'Sigue pasando' },
      residente,
    );

    expect(pqrs.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: PQR.toString(), copropiedadId: COPROPIEDAD, autorId: CUENTA },
      {
        $push: {
          seguimientos: {
            autor: 'Juan Pérez',
            mensaje: 'Sigue pasando',
            fecha: expect.any(Date) as Date,
          },
        },
      },
      { new: true },
    );
  });

  it('responder en una PQR ajena es 404 y no avisa a nadie', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.responderPropia(PQR.toString(), { mensaje: 'x' }, residente),
    ).rejects.toThrow(NotFoundException);
    expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
  });

  it('sin una cuenta utilizable ninguna operación propia degrada a "todas": es 403', async () => {
    const { servicio, pqrs } = montar();
    const sinCuenta = { ...residente, accountId: undefined };

    await expect(servicio.listarPropias({}, sinCuenta)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      servicio.obtenerPropia(PQR.toString(), sinCuenta),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      servicio.responderPropia(PQR.toString(), { mensaje: 'x' }, sinCuenta),
    ).rejects.toThrow(ForbiddenException);
    expect(pqrs.find).not.toHaveBeenCalled();
    expect(pqrs.findOne).not.toHaveBeenCalled();
  });
});
