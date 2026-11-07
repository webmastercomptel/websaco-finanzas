import { Types } from 'mongoose';
import {
  toBloque,
  toMiDocumento,
  toUnidadBloque,
} from './facturacion-bloque.mapper';

const bloque = (extra: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId(),
    copropiedadId: new Types.ObjectId(),
    tipo: 'factura',
    periodo: '2026-07',
    nombre: 'a.pdf',
    rutaOriginal: 'facturacion-bloque/x/y/original.pdf',
    estado: 'generado',
    tamanoBytes: 10,
    totalPaginas: 3,
    totalUnidades: 2,
    paginasSinMatch: [1],
    unidadesNoRegistradas: [{ codigo: '999', paginas: [2] }],
    motivoError: null,
    subidoPorNombre: 'Ana',
    enviadoEn: null,
    enviadoPorNombre: '',
    tokenEnvio: 'secreto',
    createdAt: new Date('2026-07-01T09:00:00.000Z'),
    ...extra,
  }) as never;

describe('toBloque', () => {
  it('convierte ids y fechas, y deja en null lo que aún no ocurrió', () => {
    const b = toBloque(bloque());

    expect(b).toMatchObject({
      tipo: 'factura',
      estado: 'generado',
      unidadesSinDestinatario: null,
      enviadoPor: null,
      enviadoEn: null,
      motivoError: null,
      subidoPor: 'Ana',
      creadoEn: '2026-07-01T09:00:00.000Z',
      unidadesNoRegistradas: [{ codigo: '999', paginas: [2] }],
    });
    expect('entrega' in b).toBe(false);
  });

  it('quién envió y cuándo solo aparecen cuando hubo envío', () => {
    const b = toBloque(
      bloque({
        enviadoEn: new Date('2026-07-05T10:00:00.000Z'),
        enviadoPorNombre: 'Ana Administradora',
        unidadesSinDestinatario: ['302'],
      }),
    );

    expect(b.enviadoPor).toBe('Ana Administradora');
    expect(b.enviadoEn).toBe('2026-07-05T10:00:00.000Z');
    expect(b.unidadesSinDestinatario).toEqual(['302']);
  });

  it('no filtra la ruta de almacenamiento ni los tokens', () => {
    const json = JSON.stringify(toBloque(bloque()));

    expect(json).not.toContain('facturacion-bloque/');
    expect(json).not.toContain('secreto');
    expect(json).not.toContain('copropiedadId');
  });
});

describe('toUnidadBloque y toMiDocumento', () => {
  const doc = {
    _id: new Types.ObjectId(),
    inmuebleId: new Types.ObjectId(),
    codigoInmueble: '301',
    tipo: 'factura',
    periodo: '2026-07',
    paginas: [1, 2],
    tamanoBytes: 99,
    rutaAlmacenamiento: 'facturacion-bloque/x/y/unidades/z.pdf',
  } as never;

  it('la fila de staff lleva páginas y tamaño, no la ruta', () => {
    const fila = toUnidadBloque(doc);

    expect(fila).toMatchObject({ codigoInmueble: '301', paginas: [1, 2] });
    expect(JSON.stringify(fila)).not.toContain('facturacion-bloque/');
  });

  it('la vista del residente cuenta las páginas y lleva el rol y la fecha de envío', () => {
    const mio = toMiDocumento(
      doc,
      'arrendatario',
      new Date('2026-07-05T10:00:00.000Z'),
    );

    expect(mio).toMatchObject({
      rol: 'arrendatario',
      cantidadPaginas: 2,
      fecha: '2026-07-05T10:00:00.000Z',
    });
  });
});
