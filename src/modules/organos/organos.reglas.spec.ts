import { Types } from 'mongoose';
import { correosDeIntegrantes, unidadesPorTercero } from './organos.reglas';

describe('unidadesPorTercero', () => {
  it('agrupa por tercero, con ambos roles y ordenado por código', () => {
    const t1 = new Types.ObjectId();
    const t2 = new Types.ObjectId();
    const mapa = unidadesPorTercero([
      { codigo: 'B-201', titularId: t1, arrendatarioId: null },
      { codigo: 'A-101', titularId: t1, arrendatarioId: t2 },
    ]);
    expect(mapa.get(t1.toString())).toEqual([
      { codigo: 'A-101', rol: 'propietario' },
      { codigo: 'B-201', rol: 'propietario' },
    ]);
    expect(mapa.get(t2.toString())).toEqual([
      { codigo: 'A-101', rol: 'arrendatario' },
    ]);
  });

  it('un tercero en ambos lados de la unidad recibe las dos filas', () => {
    const t = new Types.ObjectId();
    const mapa = unidadesPorTercero([
      { codigo: 'A-1', titularId: t, arrendatarioId: t },
    ]);
    expect(mapa.get(t.toString())).toHaveLength(2);
  });
});

describe('correosDeIntegrantes', () => {
  it('une los correos válidos sin repetir entre personas', () => {
    expect(
      correosDeIntegrantes([
        { emails: [' a@x.co '] },
        { emails: ['A@X.CO', 'b@x.co', 'mal'] },
      ]),
    ).toEqual(['a@x.co', 'b@x.co']);
  });
});
