import { Types } from 'mongoose';
import {
  fragmento,
  toResultadoDocumento,
  toResultadoReserva,
} from './busqueda-administracion.mapper';

describe('busqueda-administracion.mapper', () => {
  describe('fragmento', () => {
    it('devuelve vacío ante texto ausente y deja intacto el texto corto', () => {
      expect(fragmento(undefined)).toBe('');
      expect(fragmento(null)).toBe('');
      expect(fragmento('corto')).toBe('corto');
    });

    it('recorta exactamente a 120 caracteres y marca el corte', () => {
      expect(fragmento('x'.repeat(120))).toBe('x'.repeat(120));
      expect(fragmento('x'.repeat(121))).toBe(`${'x'.repeat(120)}...`);
    });
  });

  describe('toResultadoDocumento', () => {
    it('codifica el slug para que un valor raro no rompa la ruta', () => {
      const id = new Types.ObjectId();

      const r = toResultadoDocumento(
        { _id: id, nombre: 'Acta', carpetaId: new Types.ObjectId() },
        'a&b=c',
      );

      expect(r.ruta).toBe(
        `/documentos?carpeta=a%26b%3Dc&abrir=${id.toString()}`,
      );
    });
  });

  describe('toResultadoReserva', () => {
    it('titula con el residente y, si falta, con la unidad', () => {
      const id = new Types.ObjectId();

      expect(
        toResultadoReserva({ _id: id, residente: 'Ana', unidad: '304' }).titulo,
      ).toBe('Ana');
      expect(
        toResultadoReserva({ _id: id, residente: '', unidad: '304' }).titulo,
      ).toBe('304');
    });
  });
});
