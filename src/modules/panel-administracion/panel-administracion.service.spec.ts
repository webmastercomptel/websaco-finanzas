import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { PanelAdministracionService } from './panel-administracion.service';

const COPROPIEDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const resuelve = <T>(valor: T) => ({
  exec: jest.fn().mockResolvedValue(valor),
});

/** `find().sort().limit().lean().exec()` chain double. */
const cadenaFind = (filas: unknown[]) => {
  const q = {
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(filas),
  };
  q.sort.mockReturnValue(q);
  q.limit.mockReturnValue(q);
  q.lean.mockReturnValue(q);
  return q;
};

/** First argument of the first call of a Jest mock, typed by the reader. */
const primerArg = <T = Record<string, unknown>>(m: jest.Mock): T =>
  (m.mock.calls[0] as unknown[])[0] as T;

/** `$match` stage of the first aggregation a mock received. */
const etapaMatch = (m: jest.Mock): Record<string, unknown> =>
  primerArg<Array<{ $match: Record<string, unknown> }>>(m)[0].$match;

/** The query double the first call of `find` returned. */
const resultadoDe = (m: jest.Mock): ReturnType<typeof cadenaFind> =>
  (m.mock.results[0] as { value: ReturnType<typeof cadenaFind> }).value;

const usuario = (
  permissions: string[],
  extra: Partial<IRequestUser> = {},
): IRequestUser => ({
  uid: 'uid',
  email: 'a@b.co',
  accountId: CUENTA.toString(),
  permissions,
  ...extra,
});

const TODOS = [
  'dashboard.ver',
  'usuarios.ver',
  'anuncios.ver',
  'tareas.ver',
  'pqr.ver',
  'reservas.ver',
];

describe('PanelAdministracionService', () => {
  let anuncios: { countDocuments: jest.Mock; find: jest.Mock };
  let tareas: { countDocuments: jest.Mock };
  let pqrs: { countDocuments: jest.Mock; aggregate: jest.Mock };
  let reservas: { aggregate: jest.Mock };
  let asignaciones: { countDocuments: jest.Mock };
  let tenant: { resolveCoPropertyId: jest.Mock };
  let service: PanelAdministracionService;

  beforeEach(() => {
    anuncios = {
      countDocuments: jest.fn().mockReturnValue(resuelve(5)),
      find: jest.fn().mockReturnValue(cadenaFind([])),
    };
    tareas = { countDocuments: jest.fn().mockReturnValue(resuelve(2)) };
    pqrs = {
      countDocuments: jest.fn().mockReturnValue(resuelve(4)),
      aggregate: jest.fn().mockReturnValue(resuelve([])),
    };
    reservas = { aggregate: jest.fn().mockReturnValue(resuelve([])) };
    asignaciones = { countDocuments: jest.fn().mockReturnValue(resuelve(7)) };
    tenant = { resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD) };
    service = new PanelAdministracionService(
      anuncios as never,
      tareas as never,
      pqrs as never,
      reservas as never,
      asignaciones as never,
      tenant as unknown as TenantContextService,
      new CaslAbilityFactory(),
    );
  });

  const sinConsultas = () => {
    expect(anuncios.countDocuments).not.toHaveBeenCalled();
    expect(anuncios.find).not.toHaveBeenCalled();
    expect(tareas.countDocuments).not.toHaveBeenCalled();
    expect(pqrs.countDocuments).not.toHaveBeenCalled();
    expect(pqrs.aggregate).not.toHaveBeenCalled();
    expect(reservas.aggregate).not.toHaveBeenCalled();
    expect(asignaciones.countDocuments).not.toHaveBeenCalled();
  };

  describe('resumenPersonal — un bloque por permiso', () => {
    it('con todos los permisos devuelve todos los bloques', async () => {
      const resumen = await service.resumenPersonal(
        usuario(TODOS, { permissions: [...TODOS, 'tareas.gestionar'] }),
      );

      expect(resumen.estadisticas).toEqual({
        usuariosActivos: { valor: 7 },
        anunciosRecientes: { valor: 5 },
        tareasPendientes: { valor: 2 },
        pqrAbiertas: { valor: 4 },
      });
      expect(resumen.pqrSemanal).toHaveLength(6);
      expect(resumen.reservas).toEqual({ ocupacion: 0, etiqueta: 'Sin datos' });
      expect(resumen.comunicaciones).toEqual([]);
    });

    it('sin ningún permiso: no hay bloques (clave ausente) y no se consulta nada', async () => {
      const resumen = await service.resumenPersonal(usuario([]));

      expect(resumen).toEqual({ estadisticas: {} });
      sinConsultas();
    });

    it('solo pqr.ver: solo los bloques de PQR; no cuenta tareas, anuncios ni reservas', async () => {
      const resumen = await service.resumenPersonal(usuario(['pqr.ver']));

      expect(resumen.estadisticas).toEqual({ pqrAbiertas: { valor: 4 } });
      expect(resumen.pqrSemanal).toBeDefined();
      expect(resumen.reservas).toBeUndefined();
      expect(resumen.comunicaciones).toBeUndefined();
      expect(tareas.countDocuments).not.toHaveBeenCalled();
      expect(anuncios.countDocuments).not.toHaveBeenCalled();
      expect(anuncios.find).not.toHaveBeenCalled();
      expect(reservas.aggregate).not.toHaveBeenCalled();
      expect(asignaciones.countDocuments).not.toHaveBeenCalled();
    });

    it('solo anuncios.ver: contador y comunicaciones; nada de PQR, tareas ni reservas', async () => {
      anuncios.find.mockReturnValue(
        cadenaFind([
          {
            _id: new Types.ObjectId(),
            categoria: 'comunidad',
            titulo: 'Asamblea general',
            publicadoEn: new Date('2026-08-01T10:00:00Z'),
            contenido: 'x'.repeat(200),
          },
        ]),
      );

      const resumen = await service.resumenPersonal(usuario(['anuncios.ver']));

      expect(resumen.estadisticas).toEqual({ anunciosRecientes: { valor: 5 } });
      expect(resumen.comunicaciones).toHaveLength(1);
      expect(resumen.comunicaciones?.[0]).toMatchObject({
        tipo: 'comunidad',
        titulo: 'Asamblea general',
        fecha: '2026-08-01T10:00:00.000Z',
      });
      expect(resumen.comunicaciones?.[0].descripcion).toHaveLength(120);
      expect(resumen.pqrSemanal).toBeUndefined();
      expect(resumen.reservas).toBeUndefined();
      expect(pqrs.countDocuments).not.toHaveBeenCalled();
      expect(pqrs.aggregate).not.toHaveBeenCalled();
      expect(tareas.countDocuments).not.toHaveBeenCalled();
      expect(reservas.aggregate).not.toHaveBeenCalled();
    });

    it('solo usuarios.ver: cuenta las asignaciones activas de la copropiedad', async () => {
      const resumen = await service.resumenPersonal(usuario(['usuarios.ver']));

      expect(resumen.estadisticas).toEqual({ usuariosActivos: { valor: 7 } });
      expect(asignaciones.countDocuments).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        alcance: 'copropiedad',
        estado: 'active',
      });
    });

    it('permitido pero vacío es cero, no ausente', async () => {
      anuncios.countDocuments.mockReturnValue(resuelve(0));
      tareas.countDocuments.mockReturnValue(resuelve(0));
      pqrs.countDocuments.mockReturnValue(resuelve(0));
      asignaciones.countDocuments.mockReturnValue(resuelve(0));

      const resumen = await service.resumenPersonal(
        usuario([...TODOS, 'tareas.gestionar']),
      );

      expect(resumen.estadisticas).toEqual({
        usuariosActivos: { valor: 0 },
        anunciosRecientes: { valor: 0 },
        tareasPendientes: { valor: 0 },
        pqrAbiertas: { valor: 0 },
      });
      expect(resumen.pqrSemanal?.map((d) => d.valor)).toEqual([
        0, 0, 0, 0, 0, 0,
      ]);
      expect(resumen.comunicaciones).toEqual([]);
    });

    it('un administrador de plataforma ve todos los bloques sin permisos de rol', async () => {
      const resumen = await service.resumenPersonal(
        usuario([], { isPlatformAdmin: true }),
      );

      expect(Object.keys(resumen.estadisticas).sort()).toEqual([
        'anunciosRecientes',
        'pqrAbiertas',
        'tareasPendientes',
        'usuariosActivos',
      ]);
      expect(resumen.reservas).toBeDefined();
    });

    it('los anuncios se cuentan y listan solo si están publicados (un borrador no se comunicó)', async () => {
      await service.resumenPersonal(usuario(['anuncios.ver']));

      const filtroConteo = primerArg(anuncios.countDocuments);
      const filtroLista = primerArg(anuncios.find);
      for (const filtro of [filtroConteo, filtroLista]) {
        expect(filtro.copropiedadId).toBe(COPROPIEDAD);
        expect(filtro.estado).toEqual({
          $in: ['enviando', 'enviado', 'fallido'],
        });
      }
      expect(resultadoDe(anuncios.find).limit).toHaveBeenCalledWith(3);
    });
  });

  describe('resumenPersonal — tareas pendientes', () => {
    it('quien tiene tareas.gestionar cuenta todas las pendientes de la copropiedad', async () => {
      await service.resumenPersonal(
        usuario(['tareas.ver', 'tareas.gestionar']),
      );

      expect(tareas.countDocuments).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        estado: 'pendiente',
      });
    });

    it('quien no gestiona solo cuenta las tareas asignadas a él', async () => {
      await service.resumenPersonal(usuario(['tareas.ver']));

      const filtro = primerArg(tareas.countDocuments);
      expect(filtro.copropiedadId).toBe(COPROPIEDAD);
      expect(filtro.estado).toBe('pendiente');
      expect(String(filtro.asignadosIds)).toBe(CUENTA.toString());
    });

    it('quien no gestiona y no tiene cuenta legible ve 0 sin consultar (falla cerrado, no "todas")', async () => {
      const resumen = await service.resumenPersonal(
        usuario(['tareas.ver'], { accountId: 'no-es-un-id' }),
      );

      expect(resumen.estadisticas.tareasPendientes).toEqual({ valor: 0 });
      expect(tareas.countDocuments).not.toHaveBeenCalled();
    });
  });

  describe('resumenPersonal — alcance de tenant y de datos', () => {
    it('todas las consultas llevan la copropiedad activa y el staff no se filtra por autor', async () => {
      await service.resumenPersonal(usuario([...TODOS, 'tareas.gestionar']));

      expect(tenant.resolveCoPropertyId).toHaveBeenCalledTimes(1);
      const filtros = [
        primerArg(anuncios.countDocuments),
        primerArg(anuncios.find),
        primerArg(tareas.countDocuments),
        primerArg(pqrs.countDocuments),
        primerArg(asignaciones.countDocuments),
        etapaMatch(pqrs.aggregate),
        etapaMatch(reservas.aggregate),
      ] as Array<Record<string, unknown>>;
      for (const filtro of filtros) {
        expect(filtro.copropiedadId).toBe(COPROPIEDAD);
        expect(filtro.autorId).toBeUndefined();
      }
    });

    it('sin copropiedad activa no consulta nada: el tenant lanza antes', async () => {
      tenant.resolveCoPropertyId.mockImplementation(() => {
        throw new ForbiddenException('No hay una copropiedad activa');
      });

      await expect(service.resumenPersonal(usuario(TODOS))).rejects.toThrow(
        ForbiddenException,
      );
      sinConsultas();
    });

    it('el gráfico semanal corta el día en la zona de Bogotá y cuenta por día', async () => {
      pqrs.aggregate.mockReturnValue(
        resuelve([
          { _id: 2, n: 3 },
          { _id: 7, n: 1 },
          { _id: 1, n: 9 },
        ]),
      );

      const resumen = await service.resumenPersonal(usuario(['pqr.ver']));

      expect(resumen.pqrSemanal).toEqual([
        { dia: 'Lun', valor: 3 },
        { dia: 'Mar', valor: 0 },
        { dia: 'Mié', valor: 0 },
        { dia: 'Jue', valor: 0 },
        { dia: 'Vie', valor: 0 },
        { dia: 'Sáb', valor: 1 },
      ]);
      const etapas = primerArg<Array<Record<string, { _id?: unknown }>>>(
        pqrs.aggregate,
      );
      expect(JSON.stringify(etapas[1].$group._id)).toContain('America/Bogota');
    });

    it('la ocupación es el porcentaje real de aprobadas sobre el total', async () => {
      reservas.aggregate.mockReturnValue(
        resuelve([
          { _id: 'aprobada', n: 3 },
          { _id: 'pendiente', n: 1 },
        ]),
      );

      const resumen = await service.resumenPersonal(usuario(['reservas.ver']));

      expect(resumen.reservas).toEqual({
        ocupacion: 75,
        etiqueta: 'Alta demanda',
      });
    });

    it('las PQR abiertas excluyen las resueltas y las cerradas', async () => {
      await service.resumenPersonal(usuario(['pqr.ver']));

      expect(pqrs.countDocuments).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        estado: { $in: ['urgente', 'en_revision', 'pendiente'] },
      });
    });
  });

  describe('resumenResidente — solo lo propio y nada financiero', () => {
    const residente = usuario([], { esResidente: true });

    it('devuelve anuncios publicados y SUS PQR y reservas, filtrados por autorId', async () => {
      const resumen = await service.resumenResidente(residente);

      expect(resumen.estadisticas).toEqual({
        anunciosRecientes: { valor: 5 },
        pqrAbiertas: { valor: 4 },
      });
      expect(resumen.pqrSemanal).toHaveLength(6);
      expect(resumen.reservas).toBeDefined();
      expect(resumen.comunicaciones).toEqual([]);

      const propios = [
        primerArg(pqrs.countDocuments),
        etapaMatch(pqrs.aggregate),
        etapaMatch(reservas.aggregate),
      ] as Array<Record<string, unknown>>;
      for (const filtro of propios) {
        expect(filtro.copropiedadId).toBe(COPROPIEDAD);
        expect(String(filtro.autorId)).toBe(CUENTA.toString());
      }
    });

    it('no trae bloques de personal: ni usuarios ni tareas, y no los consulta', async () => {
      const resumen = await service.resumenResidente(residente);

      expect(resumen.estadisticas.usuariosActivos).toBeUndefined();
      expect(resumen.estadisticas.tareasPendientes).toBeUndefined();
      expect(asignaciones.countDocuments).not.toHaveBeenCalled();
      expect(tareas.countDocuments).not.toHaveBeenCalled();
    });

    it('no contiene nada financiero: ni enlace de pago ni cifras de cartera', async () => {
      const resumen = await service.resumenResidente(residente);

      const claves = JSON.stringify(resumen).toLowerCase();
      for (const palabra of ['pago', 'saldo', 'cartera', 'factura', 'monto']) {
        expect(claves).not.toContain(palabra);
      }
      expect(resumen).not.toHaveProperty('pagos');
    });

    it('sin cuenta legible falla cerrado con 403 y no consulta nada', async () => {
      await expect(
        service.resumenResidente(usuario([], { accountId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.resumenResidente(usuario([], { accountId: 'xx' })),
      ).rejects.toThrow(ForbiddenException);
      sinConsultas();
    });

    it('las consultas de anuncios del residente también están acotadas a la copropiedad y a lo publicado', async () => {
      await service.resumenResidente(residente);

      const filtro = primerArg(anuncios.countDocuments);
      expect(filtro.copropiedadId).toBe(COPROPIEDAD);
      expect(filtro.estado).toEqual({
        $in: ['enviando', 'enviado', 'fallido'],
      });
    });
  });
});
