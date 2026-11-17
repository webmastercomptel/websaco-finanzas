import { Types } from 'mongoose';
import type { MantenimientoDocument } from '../../database/schemas/administracion/mantenimiento.schema';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toMantenimiento,
} from './mantenimientos.mapper';

const id = new Types.ObjectId();
const tecnicoId = new Types.ObjectId();

const documento = (extra: Record<string, unknown> = {}) =>
  ({
    _id: id,
    codigo: 'MNT-007',
    titulo: 'Revisión',
    descripcion: '',
    tipo: 'correctivo',
    estado: 'en_progreso',
    prioridad: 'urgente',
    fecha: new Date('2026-09-10T08:00:00.000Z'),
    horario: '08:00 - 10:00',
    proveedor: { nombre: 'Laura Gómez' },
    tecnicoId,
    ubicacion: 'Lobby',
    notas: 'Llevar escalera',
    costoEstimado: 150000,
    completadoEn: new Date('2026-09-11T08:00:00.000Z'),
    ...extra,
  }) as unknown as MantenimientoDocument;

describe('toMantenimiento', () => {
  it('convierte ids y fechas, y compone las iniciales del proveedor', () => {
    expect(toMantenimiento(documento())).toEqual({
      id: id.toString(),
      codigo: 'MNT-007',
      titulo: 'Revisión',
      descripcion: '',
      tipo: 'correctivo',
      estado: 'en_progreso',
      prioridad: 'urgente',
      fecha: '2026-09-10T08:00:00.000Z',
      horario: '08:00 - 10:00',
      proveedor: { nombre: 'Laura Gómez', iniciales: 'LG' },
      tecnicoId: tecnicoId.toString(),
      ubicacion: 'Lobby',
      notas: 'Llevar escalera',
      costoEstimado: 150000,
      completadoEn: '2026-09-11T08:00:00.000Z',
      equipo: null,
      periodicidad: null,
      siguienteId: null,
    });
  });

  it('un documento sin los campos nuevos sale con equipo, periodicidad y siguienteId en null', () => {
    const contrato = toMantenimiento(documento());

    expect(contrato.equipo).toBeNull();
    expect(contrato.periodicidad).toBeNull();
    expect(contrato.siguienteId).toBeNull();
  });

  it('equipo sale { id, nombre } si el id está en el mapa y null si el vínculo quedó colgando', () => {
    const equipoId = new Types.ObjectId();
    const doc = documento({ equipoId, periodicidad: 'anual', siguienteId: id });

    expect(
      toMantenimiento(doc, new Map([[equipoId.toString(), 'Bomba']])),
    ).toMatchObject({
      equipo: { id: equipoId.toString(), nombre: 'Bomba' },
      periodicidad: 'anual',
      siguienteId: id.toString(),
    });
    expect(toMantenimiento(doc, new Map()).equipo).toBeNull();
    expect(toMantenimiento(doc).equipo).toBeNull();
  });

  it('las columnas nulas salen como claves ausentes y tecnicoId como null', () => {
    const contrato = toMantenimiento(
      documento({
        prioridad: null,
        horario: null,
        tecnicoId: null,
        notas: null,
        costoEstimado: null,
        completadoEn: null,
      }),
    );

    expect(contrato.tecnicoId).toBeNull();
    expect(contrato.prioridad).toBeUndefined();
    expect(contrato.horario).toBeUndefined();
    expect(contrato.notas).toBeUndefined();
    expect(contrato.costoEstimado).toBeUndefined();
    expect(contrato.completadoEn).toBeUndefined();
  });
});

describe('desdeCrearDto', () => {
  it('rellena los valores por defecto y nunca marca el mantenimiento como completado', () => {
    const copropiedadId = new Types.ObjectId();

    const campos = desdeCrearDto(
      {
        titulo: 'x',
        tipo: 'preventivo',
        fecha: '2026-09-10T08:00:00.000Z',
        proveedor: {},
      },
      copropiedadId,
      { nombre: 'Ana', tecnicoId: null },
    );

    expect(campos).toMatchObject({
      copropiedadId,
      descripcion: '',
      estado: 'programado',
      prioridad: null,
      horario: null,
      proveedor: { nombre: 'Ana' },
      tecnicoId: null,
      ubicacion: '',
      notas: null,
      costoEstimado: null,
      completadoEn: null,
    });
  });
});

describe('desdeActualizarDto', () => {
  it('null limpia equipoId y periodicidad; un id se escribe como ObjectId', () => {
    const equipoId = new Types.ObjectId();
    expect(desdeActualizarDto({ equipoId: null, periodicidad: null })).toEqual({
      equipoId: null,
      periodicidad: null,
    });
    expect(
      desdeActualizarDto({
        equipoId: equipoId.toString(),
        periodicidad: 'anual',
      }),
    ).toEqual({ equipoId, periodicidad: 'anual' });
  });

  it('solo incluye lo que el cliente envió', () => {
    expect(desdeActualizarDto({ titulo: 'Nuevo', costoEstimado: 0 })).toEqual({
      titulo: 'Nuevo',
      costoEstimado: 0,
    });
  });

  it('escribe el proveedor y el vínculo con el técnico solo si se resolvió uno', () => {
    expect(desdeActualizarDto({})).toEqual({});
    expect(
      desdeActualizarDto({}, { nombre: 'Ana', tecnicoId: tecnicoId }),
    ).toEqual({ proveedor: { nombre: 'Ana' }, tecnicoId });
  });

  it('convierte fecha y completadoEn a Date', () => {
    const cambios = desdeActualizarDto({
      fecha: '2026-09-10T08:00:00.000Z',
      completadoEn: '2026-09-11T08:00:00.000Z',
    });

    expect(cambios.fecha).toEqual(new Date('2026-09-10T08:00:00.000Z'));
    expect(cambios.completadoEn).toEqual(new Date('2026-09-11T08:00:00.000Z'));
  });
});
