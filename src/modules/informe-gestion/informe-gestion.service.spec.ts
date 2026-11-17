import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { generarPdfInformeGestion } from '../../common/pdf/informe-gestion-pdf';
import { InformeGestionService } from './informe-gestion.service';

// The PDF builder pulls @react-pdf/renderer, which cannot load under Jest here.
jest.mock('../../common/pdf/informe-gestion-pdf', () => ({
  generarPdfInformeGestion: jest.fn(),
}));

const COPROPIEDAD = new Types.ObjectId();
const PDF = Buffer.from('pdf');

/** `find().select().sort().lean().exec()` chain double. */
const cadena = (filas: unknown[]) => {
  const q = {
    select: jest.fn(),
    sort: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(filas),
  };
  q.select.mockReturnValue(q);
  q.sort.mockReturnValue(q);
  q.lean.mockReturnValue(q);
  return q;
};
const modelo = (filas: unknown[] = []) => ({
  find: jest.fn().mockReturnValue(cadena(filas)),
});

const usuario = (permissions: string[]): IRequestUser => ({
  uid: 'uid',
  email: 'a@b.co',
  accountId: new Types.ObjectId().toString(),
  permissions,
});

const TODOS = ['actividades.ver', 'mantenimientos.ver', 'pqr.ver'];
const PERIODO = { desde: '2026-03-01', hasta: '2026-03-31' };

describe('InformeGestionService', () => {
  let m: Record<
    'actividades' | 'mantenimientos' | 'pqrs' | 'equipos' | 'tecnicos',
    ReturnType<typeof modelo>
  >;
  let copropiedades: { findById: jest.Mock };
  let service: InformeGestionService;
  const copropiedad = { _id: COPROPIEDAD, nombre: 'Torres' };
  const generar = generarPdfInformeGestion as jest.Mock;
  /** Argument n of the builder's first call. */
  const arg = (n: number): unknown => (generar.mock.calls[0] as unknown[])[n];

  const nuevo = (): InformeGestionService =>
    new InformeGestionService(
      m.actividades as never,
      m.mantenimientos as never,
      m.pqrs as never,
      m.equipos as never,
      m.tecnicos as never,
      copropiedades as never,
      {
        resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
      } as unknown as TenantContextService,
      new CaslAbilityFactory(),
    );

  beforeEach(() => {
    jest.clearAllMocks();
    generar.mockResolvedValue(PDF);
    m = {
      actividades: modelo(),
      mantenimientos: modelo(),
      pqrs: modelo(),
      equipos: modelo(),
      tecnicos: modelo(),
    };
    copropiedades = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(copropiedad),
      }),
    };
    service = nuevo();
  });

  it('con solo pqr.ver el generador recibe únicamente pqr y no consulta lo demás', async () => {
    await service.generarPdf(usuario(['pqr.ver']), PERIODO);

    expect(generar).toHaveBeenCalledTimes(1);
    const secciones = arg(2) as Record<string, unknown>;
    expect(Object.keys(secciones)).toEqual(['pqr']);
    expect(m.actividades.find).not.toHaveBeenCalled();
    expect(m.mantenimientos.find).not.toHaveBeenCalled();
    expect(m.equipos.find).not.toHaveBeenCalled();
    expect(m.tecnicos.find).not.toHaveBeenCalled();
    expect(m.pqrs.find).toHaveBeenCalled();
  });

  it('devuelve el buffer y entrega copropiedad y período al generador', async () => {
    const r = await service.generarPdf(usuario(TODOS), PERIODO);

    expect(r).toBe(PDF);
    expect(arg(0)).toBe(copropiedad);
    expect(arg(1)).toEqual(PERIODO);
  });

  it('todas las consultas llevan copropiedadId y la ventana de fechas por tipo', async () => {
    await service.generarPdf(usuario(TODOS), PERIODO);

    const f = (mm: ReturnType<typeof modelo>) =>
      (mm.find.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const utc = {
      $gte: new Date('2026-03-01T00:00:00.000Z'),
      $lt: new Date('2026-04-01T00:00:00.000Z'),
    };
    const bogota = {
      $gte: new Date('2026-03-01T05:00:00.000Z'),
      $lt: new Date('2026-04-01T05:00:00.000Z'),
    };
    expect(f(m.actividades)).toEqual({
      copropiedadId: COPROPIEDAD,
      fecha: utc,
    });
    expect(f(m.mantenimientos)).toEqual({
      copropiedadId: COPROPIEDAD,
      fecha: utc,
    });
    expect(f(m.pqrs)).toEqual({
      copropiedadId: COPROPIEDAD,
      createdAt: bogota,
    });
  });

  it('cada lectura proyecta solo los campos que el informe usa', async () => {
    await service.generarPdf(usuario(TODOS), PERIODO);

    const sel = (mm: ReturnType<typeof modelo>) =>
      (mm.find.mock.results[0].value as { select: jest.Mock }).select;
    expect(sel(m.actividades)).toHaveBeenCalledWith(
      'fecha titulo categoria estado participantesIds',
    );
    expect(sel(m.mantenimientos)).toHaveBeenCalledWith(
      'fecha titulo tipo estado costoEstimado equipoId tecnicoId proveedor.nombre',
    );
    expect(sel(m.pqrs)).toHaveBeenCalledWith(
      'createdAt codigo unidad tipo prioridad estado',
    );
  });

  it('un período inválido responde 400 con el texto exacto y no consulta nada', async () => {
    const intento = service.generarPdf(usuario(TODOS), {
      desde: '2026-03-31',
      hasta: '2026-03-01',
    });
    await expect(intento).rejects.toThrow(BadRequestException);
    await expect(intento).rejects.toThrow(
      'La fecha Desde no puede ser posterior a Hasta.',
    );
    expect(m.pqrs.find).not.toHaveBeenCalled();
    expect(generar).not.toHaveBeenCalled();
  });

  it('un período mayor a un año responde 400', async () => {
    await expect(
      service.generarPdf(usuario(TODOS), {
        desde: '2025-01-01',
        hasta: '2026-01-02',
      }),
    ).rejects.toThrow('El período no puede superar un año.');
  });

  it('copropiedad inexistente responde 404', async () => {
    copropiedades.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    await expect(service.generarPdf(usuario(TODOS), PERIODO)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('actividad: inscritos = participantesIds.length', async () => {
    const fecha = new Date('2026-03-05T00:00:00.000Z');
    m.actividades = modelo([
      {
        fecha,
        titulo: 'Yoga',
        categoria: 'salud',
        estado: 'proximo',
        participantesIds: [new Types.ObjectId(), new Types.ObjectId()],
      },
    ]);
    service = nuevo();

    await service.generarPdf(usuario(['actividades.ver']), PERIODO);

    const secciones = arg(2) as { actividades: unknown[] };
    expect(secciones.actividades).toEqual([
      {
        fecha,
        titulo: 'Yoga',
        categoria: 'salud',
        estado: 'proximo',
        inscritos: 2,
      },
    ]);
  });

  describe('mantenimientos: equipo y responsable', () => {
    const eqId = new Types.ObjectId();
    const tecId = new Types.ObjectId();
    const base = (extra: object) => ({
      fecha: new Date('2026-03-10T00:00:00.000Z'),
      titulo: 'Revisión',
      tipo: 'preventivo',
      estado: 'programado',
      costoEstimado: null,
      equipoId: null,
      tecnicoId: null,
      proveedor: { nombre: 'Proveedor SA' },
      ...extra,
    });

    const filas = async (rows: object[]) => {
      m.mantenimientos = modelo(rows);
      service = nuevo();
      await service.generarPdf(usuario(['mantenimientos.ver']), PERIODO);
      return (
        arg(2) as {
          mantenimientos: Record<string, unknown>[];
        }
      ).mantenimientos;
    };

    it('usa el nombre del equipo y del técnico, ambos buscados con copropiedadId', async () => {
      m.equipos = modelo([{ _id: eqId, nombre: 'Ascensor 1' }]);
      m.tecnicos = modelo([{ _id: tecId, nombre: 'Luis Técnico' }]);
      const r = await filas([base({ equipoId: eqId, tecnicoId: tecId })]);

      expect(r[0]).toMatchObject({
        equipo: 'Ascensor 1',
        responsable: 'Luis Técnico',
        equipoId: eqId.toString(),
        costoEstimado: null,
      });
      expect((m.equipos.find.mock.calls[0] as unknown[])[0]).toEqual({
        copropiedadId: COPROPIEDAD,
        _id: { $in: [eqId] },
      });
      expect((m.tecnicos.find.mock.calls[0] as unknown[])[0]).toEqual({
        copropiedadId: COPROPIEDAD,
        _id: { $in: [tecId] },
      });
      const sel = (mm: ReturnType<typeof modelo>) =>
        (mm.find.mock.results[0].value as { select: jest.Mock }).select;
      expect(sel(m.equipos)).toHaveBeenCalledWith('nombre');
      expect(sel(m.tecnicos)).toHaveBeenCalledWith('nombre');
    });

    it('equipo borrado es null y un técnico que no resuelve cae al proveedor', async () => {
      const r = await filas([base({ equipoId: eqId, tecnicoId: tecId })]);

      expect(r[0]).toMatchObject({
        equipo: null,
        responsable: 'Proveedor SA',
      });
    });

    it('sin técnico ni proveedor el responsable es null y no consulta catálogos', async () => {
      const r = await filas([base({ proveedor: undefined })]);

      expect(r[0]).toMatchObject({ equipo: null, responsable: null });
      expect(m.equipos.find).not.toHaveBeenCalled();
      expect(m.tecnicos.find).not.toHaveBeenCalled();
    });
  });

  it('pqr: mapea createdAt a fecha', async () => {
    const createdAt = new Date('2026-03-02T15:00:00.000Z');
    m.pqrs = modelo([
      {
        createdAt,
        codigo: 'PQR-001',
        unidad: 'A-101',
        tipo: 'quejas',
        prioridad: 'alta',
        estado: 'urgente',
      },
    ]);
    service = nuevo();

    await service.generarPdf(usuario(['pqr.ver']), PERIODO);

    expect((arg(2) as { pqr: unknown[] }).pqr).toEqual([
      {
        fecha: createdAt,
        codigo: 'PQR-001',
        unidad: 'A-101',
        tipo: 'quejas',
        prioridad: 'alta',
        estado: 'urgente',
      },
    ]);
  });
});
