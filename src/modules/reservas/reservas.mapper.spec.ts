import { Types } from 'mongoose';
import type { ReservaDocument } from '../../database/schemas/administracion/reserva.schema';
import {
  nombreDeZona,
  poblarZona,
  toReserva,
  toReservaSolicitud,
} from './reservas.mapper';

const reserva = (extra: Record<string, unknown> = {}): ReservaDocument =>
  ({
    _id: new Types.ObjectId(),
    copropiedadId: new Types.ObjectId(),
    zonaId: { _id: new Types.ObjectId(), nombre: 'Salón social' },
    autorId: new Types.ObjectId(),
    residente: 'Laura Gómez',
    unidad: 'A-101',
    inicio: new Date('2026-09-01T14:00:00.000Z'),
    fin: new Date('2026-09-01T16:00:00.000Z'),
    motivo: 'Cumpleaños',
    estado: 'pendiente',
    activa: true,
    ...extra,
  }) as unknown as ReservaDocument;

describe('nombreDeZona', () => {
  it('lee el nombre de una zona poblada', () => {
    expect(nombreDeZona({ nombre: 'Gym' })).toBe('Gym');
  });

  it('un ObjectId sin poblar, un null (zona de otra copropiedad) o basura leen como vacío', () => {
    expect(nombreDeZona(new Types.ObjectId())).toBe('');
    expect(nombreDeZona(null)).toBe('');
    expect(nombreDeZona({ nombre: 5 })).toBe('');
    expect(nombreDeZona('x')).toBe('');
  });
});

describe('poblarZona', () => {
  it('la población queda dentro de la copropiedad: una zona ajena no filtra su nombre', () => {
    const copropiedadId = new Types.ObjectId();

    expect(poblarZona(copropiedadId)).toEqual({
      path: 'zonaId',
      select: 'nombre',
      match: { copropiedadId },
    });
  });
});

describe('toReserva', () => {
  it('traduce el documento al contrato', () => {
    const doc = reserva();

    expect(toReserva(doc)).toEqual({
      id: doc._id.toString(),
      espacio: 'Salón social',
      residente: 'Laura Gómez',
      residenteId: doc.autorId?.toString(),
      inmueble: 'A-101',
      fecha: '2026-09-01T14:00:00.000Z',
      horario: '14:00 - 16:00',
      estado: 'pendiente_aprobacion',
      motivo: 'Cumpleaños',
    });
  });

  it.each([
    ['pendiente', 'pendiente_aprobacion'],
    ['aprobada', 'confirmada'],
    ['rechazada', 'cancelada'],
    ['cancelada', 'cancelada'],
  ])('el estado guardado %s se muestra como %s', (guardado, visible) => {
    expect(toReserva(reserva({ estado: guardado })).estado).toBe(visible);
  });

  it('una reserva registrada por el personal no tiene residenteId ni motivo', () => {
    const resultado = toReserva(reserva({ autorId: null, motivo: null }));

    expect(resultado.residenteId).toBeUndefined();
    expect(resultado.motivo).toBeUndefined();
  });

  it('no filtra los campos internos de la guarda de doble reserva', () => {
    const resultado = toReserva(reserva({ franjas: [1, 2, 3] }));

    expect(resultado).not.toHaveProperty('activa');
    expect(resultado).not.toHaveProperty('franjas');
  });
});

describe('toReservaSolicitud', () => {
  it('traduce el documento a una fila de la cola de aprobación', () => {
    const doc = reserva();

    expect(toReservaSolicitud(doc)).toEqual({
      id: doc._id.toString(),
      residente: { nombre: 'Laura Gómez', unidad: 'A-101', iniciales: 'LG' },
      area: 'Salón social',
      fecha: '2026-09-01T14:00:00.000Z',
      horario: '14:00 - 16:00',
      estado: 'pendiente',
      notas: 'Cumpleaños',
    });
  });

  it.each([
    ['pendiente', 'pendiente'],
    ['aprobada', 'aprobada'],
    ['rechazada', 'rechazada'],
  ])('el estado guardado %s se muestra como %s', (guardado, visible) => {
    expect(toReservaSolicitud(reserva({ estado: guardado })).estado).toBe(
      visible,
    );
  });

  it('sin motivo las notas son null', () => {
    expect(toReservaSolicitud(reserva({ motivo: null })).notas).toBeNull();
  });
});
