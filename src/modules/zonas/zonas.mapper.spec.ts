import { Types } from 'mongoose';
import type { ZonaDocument } from '../../database/schemas/administracion/zona.schema';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toEspacio,
  toZonaComun,
} from './zonas.mapper';

const zona = (extra: Record<string, unknown> = {}): ZonaDocument =>
  ({
    _id: new Types.ObjectId(),
    copropiedadId: new Types.ObjectId(),
    codigo: 'ZC-001',
    nombre: 'Salón social',
    tipo: 'social',
    descripcion: 'Para eventos',
    capacidad: 40,
    horario: '08:00 - 20:00',
    requiereReserva: true,
    costo: 50000,
    imagenUrl: 'https://img/x.png',
    reglas: ['No fumar'],
    estado: 'disponible',
    ...extra,
  }) as unknown as ZonaDocument;

describe('toZonaComun', () => {
  it('traduce el documento al contrato sin traducir enums (ya son los del contrato)', () => {
    const doc = zona({ tipo: 'deportiva', estado: 'cerrada' });

    expect(toZonaComun(doc)).toEqual({
      id: doc._id.toString(),
      codigo: 'ZC-001',
      nombre: 'Salón social',
      tipo: 'deportiva',
      descripcion: 'Para eventos',
      capacidad: 40,
      horario: '08:00 - 20:00',
      estado: 'cerrada',
      requiereReserva: true,
      costo: 50000,
      imagen: 'https://img/x.png',
      reglas: ['No fumar'],
    });
  });
});

describe('toEspacio', () => {
  it('la vista del residente trae menos que la del personal: sin código ni reglas', () => {
    const espacio = toEspacio(zona());

    expect(espacio).not.toHaveProperty('codigo');
    expect(espacio).not.toHaveProperty('reglas');
    expect(espacio).toMatchObject({
      nombre: 'Salón social',
      aforo: 40,
      categoria: 'social',
    });
  });

  it('deportiva es deportes y cualquier otro tipo es social', () => {
    expect(toEspacio(zona({ tipo: 'deportiva' })).categoria).toBe('deportes');
    expect(toEspacio(zona({ tipo: 'parqueadero' })).categoria).toBe('social');
  });

  it('solo mantenimiento se ve como mantenimiento; ocupada y cerrada se ven disponibles', () => {
    expect(toEspacio(zona({ estado: 'mantenimiento' })).estado).toBe(
      'mantenimiento',
    );
    expect(toEspacio(zona({ estado: 'ocupada' })).estado).toBe('disponible');
    expect(toEspacio(zona({ estado: 'cerrada' })).estado).toBe('disponible');
  });
});

describe('desdeCrearDto', () => {
  it('rellena los valores por omisión y fija la copropiedad del contexto', () => {
    const copropiedadId = new Types.ObjectId();

    expect(
      desdeCrearDto({ nombre: 'Gym', tipo: 'deportiva' }, copropiedadId),
    ).toEqual({
      copropiedadId,
      nombre: 'Gym',
      tipo: 'deportiva',
      descripcion: '',
      capacidad: 1,
      horario: '',
      requiereReserva: false,
      costo: null,
      imagenUrl: null,
      reglas: [],
      estado: 'disponible',
    });
  });
});

describe('desdeActualizarDto', () => {
  it('solo escribe lo que el cliente mandó, incluido null para limpiar (también la imagen subida)', () => {
    expect(
      desdeActualizarDto({ nombre: 'Nuevo', costo: null, imagen: null }),
    ).toEqual({
      nombre: 'Nuevo',
      costo: null,
      imagenUrl: null,
      imagenRuta: null,
    });
  });

  it('un cuerpo vacío no escribe nada', () => {
    expect(desdeActualizarDto({})).toEqual({});
  });
});
