import { Types } from 'mongoose';
import { desdeActualizarDto, desdeCrearDto, toTarea } from './tareas.mapper';

const ID = new Types.ObjectId();
const AUTOR = new Types.ObjectId();

const documento = (extra: Record<string, unknown> = {}) =>
  ({
    _id: ID,
    titulo: 'Podar el jardín',
    descripcion: 'Zona norte',
    categoria: 'mantenimiento',
    prioridad: 'alta',
    estado: 'en_progreso',
    asignadosIds: [],
    progreso: 50,
    fechaLimite: new Date('2026-03-04T05:06:07Z'),
    historial: [
      {
        accion: 'Creó la tarea',
        usuario: 'Ana',
        fecha: new Date('2026-03-01T00:00:00Z'),
      },
    ],
    observaciones: [
      {
        texto: 'Falta abono',
        autorId: AUTOR,
        fecha: new Date('2026-03-02T00:00:00Z'),
      },
    ],
    ...extra,
  }) as never;

describe('toTarea', () => {
  it('copia los valores del contrato tal cual (no hay traducción de enums) y convierte ids y fechas', () => {
    expect(toTarea(documento())).toEqual({
      id: ID.toString(),
      titulo: 'Podar el jardín',
      descripcion: 'Zona norte',
      categoria: 'mantenimiento',
      prioridad: 'alta',
      estado: 'en_progreso',
      asignados: [],
      progreso: 50,
      fechaLimite: '2026-03-04T05:06:07.000Z',
      historial: [
        {
          accion: 'Creó la tarea',
          usuario: 'Ana',
          fecha: '2026-03-01T00:00:00.000Z',
        },
      ],
      observaciones: [
        {
          texto: 'Falta abono',
          autorId: AUTOR.toString(),
          fecha: '2026-03-02T00:00:00.000Z',
        },
      ],
    });
  });

  it('arma los asignados desde las cuentas pobladas, con iniciales y avatar nulo', () => {
    const tarea = toTarea(
      documento({
        asignadosIds: [{ _id: ID, nombreCompleto: 'Laura Gómez' }],
      }),
    );

    expect(tarea.asignados).toEqual([
      { nombre: 'Laura Gómez', iniciales: 'LG', avatar: null },
    ]);
  });

  it('ignora los asignados sin poblar (ids sueltos)', () => {
    expect(
      toTarea(documento({ asignadosIds: [new Types.ObjectId()] })).asignados,
    ).toEqual([]);
  });

  it('progreso y fecha límite nulos salen como ausentes', () => {
    const tarea = toTarea(documento({ progreso: null, fechaLimite: null }));

    expect(tarea.progreso).toBeUndefined();
    expect(tarea.fechaLimite).toBeUndefined();
  });
});

describe('desdeCrearDto / desdeActualizarDto', () => {
  const COP = new Types.ObjectId();

  it('crear: usa la copropiedad recibida y los valores por defecto', () => {
    expect(desdeCrearDto({ titulo: 'x', categoria: 'admin' }, COP)).toEqual({
      copropiedadId: COP,
      titulo: 'x',
      descripcion: '',
      categoria: 'admin',
      prioridad: 'normal',
      estado: 'pendiente',
      asignadosIds: [],
      progreso: null,
      fechaLimite: null,
      orden: 0,
    });
  });

  it('crear: convierte ids y fecha', () => {
    const asignado = new Types.ObjectId();
    const cambios = desdeCrearDto(
      {
        titulo: 'x',
        categoria: 'admin',
        asignadosIds: [asignado.toString()],
        fechaLimite: '2026-03-04T05:06:07Z',
      },
      COP,
    );

    expect(cambios.asignadosIds).toEqual([asignado]);
    expect(cambios.fechaLimite).toEqual(new Date('2026-03-04T05:06:07Z'));
  });

  it('actualizar: solo incluye lo que el cliente envió', () => {
    expect(desdeActualizarDto({ estado: 'pendiente', orden: 2 })).toEqual({
      estado: 'pendiente',
      orden: 2,
    });
    expect(desdeActualizarDto({})).toEqual({});
  });

  it('actualizar: fechaLimite null se conserva como null (borra la fecha)', () => {
    expect(desdeActualizarDto({ fechaLimite: null })).toEqual({
      fechaLimite: null,
    });
  });
});
