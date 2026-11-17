/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the assertions read the untyped payloads recorded by the jest mocks */
import {
  BadRequestException,
  ConflictException,
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
  updateOne: jest.Mock;
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
  correoProbadoClave: null,
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
  pqrs.updateOne = jest.fn().mockReturnValue(consulta({ modifiedCount: 1 }));

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
    notificarAcuse: jest.fn().mockResolvedValue({ tipo: 'acuse_enviado' }),
    avisarOrgano: jest.fn().mockResolvedValue({ tipo: 'aviso_organo' }),
    notificarCierre: jest.fn().mockResolvedValue(undefined),
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

  it('guarda en la bitácora el evento del acuse de recibo', async () => {
    const { servicio, pqrs, notificaciones } = montar();

    await servicio.crear(dto, staff);

    expect(notificaciones.notificarAcuse).toHaveBeenCalledTimes(1);
    expect(pqrs.updateOne).toHaveBeenCalledWith(
      { _id: PQR, copropiedadId: COPROPIEDAD },
      { $push: { bitacora: { tipo: 'acuse_enviado' } } },
    );
  });

  it('si la escritura del acuse falla, la PQRS se crea igual', async () => {
    const { servicio, pqrs } = montar();
    pqrs.updateOne.mockReturnValue({
      exec: jest.fn().mockRejectedValue(new Error('transitorio')),
    });

    await expect(servicio.crear(dto, staff)).resolves.toBeDefined();
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
      estado: { $in: ['cerrada', 'resuelto', 'cerrado'] },
    });
    expect(pqrs.find).toHaveBeenNthCalledWith(2, {
      copropiedadId: COPROPIEDAD,
    });
  });

  it('el filtro de etapa abarca los valores heredados', async () => {
    const { servicio, pqrs } = montar();

    await servicio.listar({ estado: 'cerrada' });
    await servicio.listar({ estado: 'radicada' });

    expect(pqrs.find).toHaveBeenNthCalledWith(1, {
      copropiedadId: COPROPIEDAD,
      estado: { $in: ['cerrada', 'resuelto', 'cerrado'] },
    });
    expect(pqrs.find).toHaveBeenNthCalledWith(2, {
      copropiedadId: COPROPIEDAD,
      estado: { $in: ['radicada', 'pendiente'] },
    });
  });

  it('vencidas: abiertas con límite anterior a hoy en Bogotá (medianoche UTC)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-10T03:00:00Z'));
    try {
      const { servicio, pqrs } = montar();

      await servicio.listar({ vencidas: true });

      // 03:00Z is still 9/3 22:00 in Bogotá.
      const filtro = pqrs.find.mock.calls[0][0] as Record<string, any>;
      expect(filtro.fechaLimite).toEqual({
        $lt: new Date('2026-03-09T00:00:00.000Z'),
      });
      expect(filtro.estado.$in).toEqual(
        expect.arrayContaining(['radicada', 'clasificada', 'en_gestion']),
      );
      expect(filtro.estado.$in).not.toContain('cerrada');
      expect(filtro.estado.$in).not.toContain('resuelto');
    } finally {
      jest.useRealTimers();
    }
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

const ID = PQR.toString();

type Cuerpo = Record<string, any>;

/** The update document of the Nth `findOneAndUpdate` call. */
const actualizacion = (m: ModeloPqr, n = 0): Cuerpo =>
  m.findOneAndUpdate.mock.calls[n][1] as Cuerpo;

/** The filter of the Nth `findOneAndUpdate` call. */
const filtroDe = (m: ModeloPqr, n = 0): Cuerpo =>
  m.findOneAndUpdate.mock.calls[n][0] as Cuerpo;

describe('PqrService — personal: clasificar', () => {
  const dto = {
    tipo: 'reclamos' as const,
    responsable: 'administracion' as const,
    fechaLimite: '2026-02-10',
  };

  it('una radicada pasa a clasificada: el filtro lleva el estado leído y se empuja el evento', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'radicada' })));

    await servicio.clasificar(ID, dto, staff);

    expect(filtroDe(pqrs)).toEqual({
      _id: ID,
      copropiedadId: COPROPIEDAD,
      estado: 'radicada',
    });
    const cambio = actualizacion(pqrs);
    expect(cambio.$set).toEqual(
      expect.objectContaining({
        estado: 'clasificada',
        tipo: 'reclamos',
        responsable: 'administracion',
        fechaLimite: new Date('2026-02-10T00:00:00.000Z'),
        clasificadaEn: expect.any(Date) as Date,
      }),
    );
    expect(cambio.$push.bitacora).toEqual(
      expect.objectContaining({
        tipo: 'clasificada',
        actor: 'Ana Admin',
        detalle:
          'Clasificada: Reclamo · Responsable: Administración · Límite: 10/2/2026',
      }),
    );
  });

  it('si cambia el tipo el detalle muestra la flecha', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'radicada' })));

    await servicio.clasificar(ID, { ...dto, tipo: 'quejas' }, staff);

    expect(actualizacion(pqrs).$push.bitacora.detalle).toBe(
      'Clasificada: Reclamo → Queja · Responsable: Administración · Límite: 10/2/2026',
    );
  });

  it('una pendiente heredada se convierte al clasificar (filtro con el valor guardado)', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'pendiente' })));

    await servicio.clasificar(ID, dto, staff);

    expect(filtroDe(pqrs).estado).toBe('pendiente');
    expect(actualizacion(pqrs).$set.estado).toBe('clasificada');
  });

  it('reclasificar una en gestión no retrocede la etapa ni reescribe clasificadaEn', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(
      consulta(
        pqrDoc({
          estado: 'urgente',
          clasificadaEn: new Date('2026-01-05T00:00:00Z'),
        }),
      ),
    );

    await servicio.clasificar(ID, dto, staff);

    expect(actualizacion(pqrs).$set.estado).toBe('en_gestion');
    expect(actualizacion(pqrs).$set).not.toHaveProperty('clasificadaEn');
  });

  it('asignar al comité avisa una vez; repetir el mismo cuerpo no vuelve a avisar', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    const comite = { ...dto, responsable: 'comite_convivencia' as const };
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'radicada' })));

    await servicio.clasificar(ID, comite, staff);

    expect(notificaciones.avisarOrgano).toHaveBeenCalledTimes(1);
    expect(notificaciones.avisarOrgano).toHaveBeenCalledWith(
      expect.anything(),
      COPROPIEDAD,
      'comite_convivencia',
    );
    expect(pqrs.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(actualizacion(pqrs, 1)).toEqual({
      $push: { bitacora: { tipo: 'aviso_organo' } },
    });

    notificaciones.avisarOrgano.mockClear();
    pqrs.findOne.mockReturnValue(
      consulta(
        pqrDoc({ estado: 'clasificada', responsable: 'comite_convivencia' }),
      ),
    );
    await servicio.clasificar(ID, comite, staff);
    expect(notificaciones.avisarOrgano).not.toHaveBeenCalled();
  });

  it('si el registro del aviso al órgano falla, la clasificación se devuelve igual', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    const comite = { ...dto, responsable: 'comite_convivencia' as const };
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'radicada' })));
    notificaciones.avisarOrgano.mockRejectedValueOnce(new Error('transitorio'));

    await expect(servicio.clasificar(ID, comite, staff)).resolves.toBeDefined();
  });

  it('la administración como responsable no avisa a ningún órgano', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.clasificar(ID, dto, staff);

    expect(notificaciones.avisarOrgano).not.toHaveBeenCalled();
  });

  it('una fecha límite el día anterior a la radicación es 400', async () => {
    const { servicio, pqrs } = montar();
    // Filed 2026-01-01T00:00Z = 31/12 19:00 in Bogotá, so the filing day is 31/12.
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ createdAt: new Date('2026-01-01T15:00:00Z') })),
    );

    await expect(
      servicio.clasificar(ID, { ...dto, fechaLimite: '2025-12-31' }, staff),
    ).rejects.toThrow(
      new BadRequestException(
        'La fecha límite no puede ser anterior a la fecha de radicación.',
      ),
    );
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('el mismo día de radicación (en Bogotá) es válido', async () => {
    const { servicio } = montar();

    await expect(
      servicio.clasificar(ID, { ...dto, fechaLimite: '2025-12-31' }, staff),
    ).resolves.toBeDefined();
  });

  it('una cerrada es 409 y no se escribe nada', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'resuelto' })));

    await expect(servicio.clasificar(ID, dto, staff)).rejects.toThrow(
      new ConflictException('Esta PQRS ya está cerrada.'),
    );
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si cambió mientras se procesaba (el filtro ya no coincide) es 409', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(servicio.clasificar(ID, dto, staff)).rejects.toThrow(
      new ConflictException('La PQRS cambió mientras se procesaba.'),
    );
  });

  it('404 con id mal formado o de otra copropiedad', async () => {
    const { servicio, pqrs } = montar();

    await expect(servicio.clasificar('mal', dto, staff)).rejects.toThrow(
      NotFoundException,
    );
    pqrs.findOne.mockReturnValue(consulta(null));
    await expect(servicio.clasificar(ID, dto, staff)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('PqrService — personal: cerrar', () => {
  it('cierra con una sola actualización condicionada a que esté abierta', async () => {
    const { servicio, pqrs, notificaciones } = montar();

    await servicio.cerrar(ID, { mensaje: 'Resuelto' }, staff);

    expect(filtroDe(pqrs)).toEqual({
      _id: ID,
      copropiedadId: COPROPIEDAD,
      estado: { $in: expect.arrayContaining(['radicada', 'pendiente']) },
    });
    expect(filtroDe(pqrs).estado.$in).not.toContain('cerrada');
    const cambio = actualizacion(pqrs);
    expect(cambio.$set).toEqual({
      estado: 'cerrada',
      cerradaEn: expect.any(Date) as Date,
      cerradaPor: 'Ana Admin',
    });
    expect(cambio.$push.seguimientos).toEqual(
      expect.objectContaining({ autor: 'Ana Admin', mensaje: 'Resuelto' }),
    );
    expect(cambio.$push.bitacora).toEqual(
      expect.objectContaining({
        tipo: 'cerrada',
        detalle: 'Respondida y cerrada por Ana Admin',
      }),
    );
    expect(notificaciones.notificarCierre).toHaveBeenCalledWith(
      expect.anything(),
      COPROPIEDAD,
      'Resuelto',
    );
  });

  it('cerrar dos veces: la segunda es 409 y el correo sale una sola vez', async () => {
    const { servicio, pqrs, notificaciones } = montar();

    await servicio.cerrar(ID, { mensaje: 'Listo' }, staff);
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));
    await expect(
      servicio.cerrar(ID, { mensaje: 'Listo' }, staff),
    ).rejects.toThrow(new ConflictException('Esta PQRS ya está cerrada.'));

    expect(notificaciones.notificarCierre).toHaveBeenCalledTimes(1);
  });

  it('si no existe en la copropiedad es 404', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(servicio.cerrar(ID, { mensaje: 'x' }, staff)).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      servicio.cerrar('mal', { mensaje: 'x' }, staff),
    ).rejects.toThrow(NotFoundException);
    expect(notificaciones.notificarCierre).not.toHaveBeenCalled();
  });
});

describe('PqrService — personal: actualizar (PATCH heredado)', () => {
  it.each(['resuelto', 'cerrado', 'cerrada'] as const)(
    'estado %s es 400: se cierra con «Responder y cerrar»',
    async (estado) => {
      const { servicio, pqrs } = montar();

      await expect(servicio.actualizar(ID, { estado }, staff)).rejects.toThrow(
        new BadRequestException(
          'Usa «Responder y cerrar» para cerrar la PQRS.',
        ),
      );
      expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('estado urgente se convierte en prioridad alta sin cambiar la etapa', async () => {
    const { servicio, pqrs } = montar();

    await servicio.actualizar(ID, { estado: 'urgente' }, staff);

    const cambio = actualizacion(pqrs);
    expect(cambio.$set).toEqual({ prioridad: 'alta' });
    expect(cambio.$push.bitacora.$each).toEqual([
      expect.objectContaining({ tipo: 'prioridad' }),
    ]);
  });

  it('cualquier otro estado se ignora: no escribe', async () => {
    const { servicio, pqrs } = montar();

    const contrato = await servicio.actualizar(
      ID,
      { estado: 'en_revision' },
      staff,
    );

    expect(contrato.id).toBe(ID);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('normaliza la prioridad heredada urgente a alta y registra el cambio', async () => {
    const { servicio, pqrs } = montar();

    await servicio.actualizar(ID, { prioridad: 'urgente' }, staff);

    expect(actualizacion(pqrs).$set).toEqual({ prioridad: 'alta' });
  });

  it('una prioridad igual a la guardada no escribe', async () => {
    const { servicio, pqrs } = montar();

    await servicio.actualizar(ID, { prioridad: 'normal' }, staff);

    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un técnico en una radicada es 409', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'radicada' })));

    await expect(
      servicio.actualizar(ID, { tecnicoId: TECNICO.toString() }, staff),
    ).rejects.toThrow(
      new ConflictException('Clasifica la PQRS antes de asignar un técnico.'),
    );
  });

  it('un técnico en una cerrada es 409', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'cerrada' })));

    await expect(
      servicio.actualizar(ID, { tecnicoId: TECNICO.toString() }, staff),
    ).rejects.toThrow(new ConflictException('Esta PQRS ya está cerrada.'));
  });

  it('asignar un técnico a una clasificada la pasa a en gestión con dos eventos', async () => {
    const { servicio, pqrs, tecnicos } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'clasificada' })));
    tecnicos.findOne.mockReturnValue(
      consulta({ _id: TECNICO, nombre: 'Pedro Plomero' }),
    );

    await servicio.actualizar(ID, { tecnicoId: TECNICO.toString() }, staff);

    expect(tecnicos.findOne).toHaveBeenCalledWith({
      _id: TECNICO.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(filtroDe(pqrs).estado).toBe('clasificada');
    const cambio = actualizacion(pqrs);
    expect(cambio.$set).toEqual({ tecnicoId: TECNICO, estado: 'en_gestion' });
    expect(cambio.$push.bitacora.$each).toEqual([
      expect.objectContaining({
        tipo: 'tecnico_asignado',
        detalle: 'Técnico asignado: Pedro Plomero',
      }),
      expect.objectContaining({ tipo: 'en_gestion' }),
    ]);
  });

  it('en gestión: asignar un técnico no toca la etapa', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'en_gestion' })));

    await servicio.actualizar(ID, { tecnicoId: TECNICO.toString() }, staff);

    expect(actualizacion(pqrs).$set).toEqual({ tecnicoId: TECNICO });
  });

  it('el mismo técnico ya asignado no escribe', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ estado: 'en_gestion', tecnicoId: TECNICO })),
    );

    await servicio.actualizar(ID, { tecnicoId: TECNICO.toString() }, staff);

    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un técnico de otro edificio (o inexistente) es 404 y no se escribe nada', async () => {
    const { servicio, pqrs, tecnicos } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'clasificada' })));
    tecnicos.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(
        ID,
        { tecnicoId: new Types.ObjectId().toString() },
        staff,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un tecnicoId mal formado es 404 sin consultar técnicos', async () => {
    const { servicio, pqrs, tecnicos } = montar();
    pqrs.findOne.mockReturnValue(consulta(pqrDoc({ estado: 'clasificada' })));

    await expect(
      servicio.actualizar(ID, { tecnicoId: 'xyz' }, staff),
    ).rejects.toThrow(NotFoundException);
    expect(tecnicos.findOne).not.toHaveBeenCalled();
  });

  it('tecnicoId null retira al técnico y lo registra', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(
      consulta(pqrDoc({ estado: 'en_gestion', tecnicoId: TECNICO })),
    );

    await servicio.actualizar(ID, { tecnicoId: null }, staff);

    const cambio = actualizacion(pqrs);
    expect(cambio.$set).toEqual({ tecnicoId: null });
    expect(cambio.$push.bitacora.$each).toEqual([
      expect.objectContaining({ tipo: 'tecnico_retirado' }),
    ]);
  });

  it('un cuerpo vacío no escribe: solo devuelve la PQRS', async () => {
    const { servicio, pqrs } = montar();

    const contrato = await servicio.actualizar(ID, {}, staff);

    expect(contrato.id).toBe(ID);
    expect(pqrs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si cambió mientras se procesaba es 409', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(ID, { prioridad: 'alta' }, staff),
    ).rejects.toThrow(
      new ConflictException('La PQRS cambió mientras se procesaba.'),
    );
  });

  it('404 si no existe en la copropiedad, y con id mal formado sin tocar la base', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.actualizar(ID, { prioridad: 'alta' }, staff),
    ).rejects.toThrow(NotFoundException);
    pqrs.findOne.mockClear();
    await expect(
      servicio.actualizar('mal', { prioridad: 'alta' }, staff),
    ).rejects.toThrow(NotFoundException);
    expect(pqrs.findOne).not.toHaveBeenCalled();
  });
});

describe('PqrService — personal: responder', () => {
  it('agrega el seguimiento y el evento respuesta en un solo $push, solo si está abierta', async () => {
    const { servicio, pqrs } = montar();

    await servicio.responder(ID, { mensaje: 'Ya vamos' }, staff);

    expect(filtroDe(pqrs)).toEqual({
      _id: ID,
      copropiedadId: COPROPIEDAD,
      estado: { $in: expect.arrayContaining(['radicada']) },
    });
    expect(actualizacion(pqrs).$push).toEqual({
      seguimientos: {
        autor: 'Ana Admin',
        mensaje: 'Ya vamos',
        fecha: expect.any(Date) as Date,
      },
      bitacora: expect.objectContaining({
        tipo: 'respuesta',
        detalle: 'Respuesta de Ana Admin',
      }),
    });
  });

  it('sin nombre en la cuenta firma como Usuario', async () => {
    const { servicio, pqrs } = montar();

    await servicio.responder(
      ID,
      { mensaje: 'x' },
      { ...staff, nombre: undefined },
    );

    expect(actualizacion(pqrs).$push.seguimientos.autor).toBe('Usuario');
  });

  it('avisa a la autora indicando quién escribió', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.responder(ID, { mensaje: 'Ya vamos' }, staff);

    expect(notificaciones.notificarRespuesta).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: 'PQR-001' }),
      COPROPIEDAD,
      { accountId: staff.accountId, nombre: 'Ana Admin' },
      'Ya vamos',
    );
  });

  it('responder una cerrada es 409 y no avisa a nadie', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.responder(ID, { mensaje: 'x' }, staff),
    ).rejects.toThrow(new ConflictException('Esta PQRS ya está cerrada.'));
    expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
  });

  it('404 si la PQRS no existe en la copropiedad', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));
    pqrs.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.responder(ID, { mensaje: 'x' }, staff),
    ).rejects.toThrow(NotFoundException);
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
      { email: 'r@x.co', correoProbadoClave: null },
    );
    expect(pqrs).toHaveBeenCalledWith(
      expect.objectContaining({
        codigo: 'PQR-001',
        copropiedadId: COPROPIEDAD,
        autorId: CUENTA,
        estado: 'radicada',
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
      {
        _id: PQR.toString(),
        copropiedadId: COPROPIEDAD,
        autorId: CUENTA,
        estado: { $in: expect.arrayContaining(['radicada']) as string[] },
      },
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

  it('responder en una PQR propia ya cerrada es 409', async () => {
    const { servicio, pqrs } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));

    await expect(
      servicio.responderPropia(PQR.toString(), { mensaje: 'x' }, residente),
    ).rejects.toThrow(new ConflictException('Esta PQRS ya está cerrada.'));
  });

  it('el residente nunca recibe el manejo interno (bitácora, responsable, plazos)', async () => {
    const { servicio, pqrs } = montar();
    pqrs.find.mockReturnValue(consulta([pqrDoc()]));

    const [una] = await servicio.listarPropias({}, residente);
    const otra = await servicio.obtenerPropia(PQR.toString(), residente);
    const creada = await servicio.crearComoResidente(
      { titulo: 'T', descripcion: 'D', tipo: 'quejas' },
      residente,
    );

    for (const vista of [una, otra, creada]) {
      for (const clave of [
        'bitacora',
        'responsable',
        'fechaLimite',
        'fechaLimiteSugerida',
        'vencida',
      ]) {
        expect(vista).not.toHaveProperty(clave);
      }
    }
  });

  it('vencidas no aplica a las del residente (no ve plazos)', async () => {
    const { servicio, pqrs } = montar();

    await servicio.listarPropias({ vencidas: true }, residente);

    expect(pqrs.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      autorId: CUENTA,
    });
  });

  it('responder en una PQR ajena es 404 y no avisa a nadie', async () => {
    const { servicio, pqrs, notificaciones } = montar();
    pqrs.findOneAndUpdate.mockReturnValue(consulta(null));
    pqrs.findOne.mockReturnValue(consulta(null));

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
