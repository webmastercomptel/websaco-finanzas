import { Types } from 'mongoose';
import type { ActividadDocument } from '../../database/schemas/administracion/actividad.schema';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toActividad,
} from './actividades.mapper';

const id = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const documento = (extra: Record<string, unknown> = {}) =>
  ({
    _id: id,
    codigo: 'ACT-004',
    titulo: 'Yoga',
    descripcion: 'Clase',
    categoria: 'salud',
    fecha: new Date('2026-09-10T08:00:00.000Z'),
    horario: '08:00',
    ubicacion: 'Salón',
    imagenUrl: 'https://img.test/y.png',
    destacado: true,
    tags: ['bienestar'],
    participantesIds: [cuenta, new Types.ObjectId()],
    capacidad: 20,
    estado: 'proximo',
    organizador: 'Administración',
    ...extra,
  }) as unknown as ActividadDocument;

describe('toActividad', () => {
  it('convierte ids y fechas, renombra imagenUrl a imagen y cuenta los asistentes', () => {
    const contrato = toActividad(documento());

    expect(contrato).toEqual({
      id: id.toString(),
      codigo: 'ACT-004',
      titulo: 'Yoga',
      descripcion: 'Clase',
      categoria: 'salud',
      fecha: '2026-09-10T08:00:00.000Z',
      horario: '08:00',
      ubicacion: 'Salón',
      imagen: 'https://img.test/y.png',
      destacado: true,
      tags: ['bienestar'],
      asistentes: 2,
      capacidad: 20,
      estado: 'proximo',
      organizador: 'Administración',
    });
  });

  it('solo incluye asistiendo cuando se conoce a quien consulta', () => {
    expect(toActividad(documento())).not.toHaveProperty('asistiendo');
    expect(toActividad(documento(), cuenta.toString()).asistiendo).toBe(true);
    expect(
      toActividad(documento(), new Types.ObjectId().toString()).asistiendo,
    ).toBe(false);
  });
});

describe('desdeCrearDto', () => {
  it('rellena los valores por defecto: capacidad 0 (nadie puede inscribirse) y sin asistentes', () => {
    const copropiedadId = new Types.ObjectId();

    const campos = desdeCrearDto(
      { titulo: 'x', categoria: 'salud', fecha: '2026-09-10T08:00:00.000Z' },
      copropiedadId,
    );

    expect(campos).toMatchObject({
      copropiedadId,
      descripcion: '',
      horario: '',
      ubicacion: '',
      imagenUrl: null,
      destacado: false,
      tags: [],
      capacidad: 0,
      estado: 'proximo',
      organizador: '',
    });
    expect(campos).not.toHaveProperty('participantesIds');
  });
});

describe('desdeActualizarDto', () => {
  it('solo incluye lo enviado y traduce imagen a imagenUrl (null limpia la imagen)', () => {
    expect(desdeActualizarDto({})).toEqual({});
    expect(
      desdeActualizarDto({ titulo: 'Nuevo', imagen: null, capacidad: 0 }),
    ).toEqual({ titulo: 'Nuevo', imagenUrl: null, capacidad: 0 });
  });
});
