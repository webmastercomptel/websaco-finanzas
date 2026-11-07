import { Types } from 'mongoose';
import {
  toComunicacion,
  toOcupacionReservas,
  toPqrSemanal,
} from './panel-administracion.mapper';

describe('panel-administracion.mapper', () => {
  describe('toOcupacionReservas', () => {
    it('sin reservas no inventa un porcentaje: 0 y "Sin datos"', () => {
      expect(toOcupacionReservas([])).toEqual({
        ocupacion: 0,
        etiqueta: 'Sin datos',
      });
    });

    it('redondea el porcentaje de aprobadas y marca "Alta demanda" desde 70', () => {
      expect(
        toOcupacionReservas([
          { _id: 'aprobada', n: 7 },
          { _id: 'rechazada', n: 3 },
        ]),
      ).toEqual({ ocupacion: 70, etiqueta: 'Alta demanda' });
    });

    it('por debajo de 70 es "Normal"', () => {
      expect(
        toOcupacionReservas([
          { _id: 'aprobada', n: 1 },
          { _id: 'pendiente', n: 2 },
        ]),
      ).toEqual({ ocupacion: 33, etiqueta: 'Normal' });
    });

    it('con reservas pero ninguna aprobada es 0 "Normal", no "Sin datos"', () => {
      expect(toOcupacionReservas([{ _id: 'cancelada', n: 4 }])).toEqual({
        ocupacion: 0,
        etiqueta: 'Normal',
      });
    });
  });

  describe('toPqrSemanal', () => {
    it('siempre devuelve de lunes a sábado, con ceros donde no hay PQR, y descarta el domingo', () => {
      const semana = toPqrSemanal([{ _id: 1, n: 5 }]);

      expect(semana.map((d) => d.dia)).toEqual([
        'Lun',
        'Mar',
        'Mié',
        'Jue',
        'Vie',
        'Sáb',
      ]);
      expect(semana.every((d) => d.valor === 0)).toBe(true);
    });
  });

  describe('toComunicacion', () => {
    it('recorta el texto a 120 caracteres y tolera un anuncio sin fecha de publicación', () => {
      const id = new Types.ObjectId();

      const c = toComunicacion({
        _id: id,
        categoria: 'seguridad',
        titulo: 'Ronda',
        publicadoEn: null,
        contenido: 'a'.repeat(300),
      });

      expect(c).toEqual({
        id: id.toString(),
        tipo: 'seguridad',
        titulo: 'Ronda',
        fecha: undefined,
        descripcion: 'a'.repeat(120),
      });
    });
  });
});
