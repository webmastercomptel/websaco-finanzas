import { Types } from 'mongoose';
import type { AnuncioDocument } from '../../database/schemas/administracion/anuncio.schema';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toAnuncio,
} from './anuncios.mapper';

const CUENTA = new Types.ObjectId();
const OTRA = new Types.ObjectId();

const doc = (extra: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId(),
    titulo: 'Corte de agua',
    contenido: 'x',
    categoria: 'mantenimiento',
    autor: 'Ana',
    imagenUrl: null,
    destacado: true,
    vistas: 7,
    meGustaIds: [CUENTA, OTRA],
    estado: 'enviado',
    publicadoEn: new Date('2026-01-15T10:00:00.000Z'),
    createdAt: new Date('2026-01-10T10:00:00.000Z'),
    notificadosIds: [CUENTA],
    correosEnviadosIds: [],
    destinatariosTotal: 4,
    correoConfigurado: true,
    tokenEnvio: 'secreto',
    ...extra,
  }) as unknown as AnuncioDocument;

describe('toAnuncio', () => {
  it('deriva likes del largo del arreglo y nunca expone ids ni el token del lease', () => {
    const resultado = toAnuncio(doc());

    expect(resultado.likes).toBe(2);
    expect(JSON.stringify(resultado)).not.toContain('secreto');
    expect(JSON.stringify(resultado)).not.toContain(CUENTA.toString());
    expect(resultado.likedByMe).toBeUndefined();
    expect(resultado.entrega).toBeUndefined();
  });

  it('marca likedByMe solo cuando se pasa la cuenta', () => {
    expect(toAnuncio(doc(), { cuentaId: CUENTA.toString() }).likedByMe).toBe(
      true,
    );
    expect(
      toAnuncio(doc(), { cuentaId: new Types.ObjectId().toString() }).likedByMe,
    ).toBe(false);
  });

  it('la entrega solo sale para staff y son conteos', () => {
    expect(toAnuncio(doc(), { incluirEntrega: true }).entrega).toEqual({
      destinatarios: 4,
      notificados: 1,
      correosEnviados: 0,
      correoConfigurado: true,
    });
  });

  it('la fecha es la de publicación y, mientras es borrador, la de creación', () => {
    expect(toAnuncio(doc()).fecha).toBe('2026-01-15T10:00:00.000Z');
    expect(toAnuncio(doc({ publicadoEn: null })).fecha).toBe(
      '2026-01-10T10:00:00.000Z',
    );
  });
});

describe('desdeCrearDto', () => {
  it('siempre es borrador, con el autor y el tenant recibidos, sin likes ni progreso', () => {
    const copropiedadId = new Types.ObjectId();

    const campos = desdeCrearDto(
      { titulo: 't', contenido: 'c', categoria: 'seguridad' },
      copropiedadId,
      'Ana',
    );

    expect(campos).toEqual({
      copropiedadId,
      titulo: 't',
      contenido: 'c',
      categoria: 'seguridad',
      autor: 'Ana',
      imagenUrl: null,
      destacado: false,
      estado: 'borrador',
    });
  });
});

describe('desdeActualizarDto', () => {
  it('solo incluye lo enviado, traduce imagen a imagenUrl y acepta null', () => {
    expect(desdeActualizarDto({})).toEqual({});
    expect(
      desdeActualizarDto({ titulo: 'x', imagen: null, destacado: false }),
    ).toEqual({ titulo: 'x', imagenUrl: null, destacado: false });
  });
});
