import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarAnuncioDto } from './actualizar-anuncio.dto';
import { CrearAnuncioDto } from './guardar-anuncio.dto';
import {
  ListarAnunciosDto,
  ListarAnunciosPortalDto,
} from './listar-anuncios.dto';
import { PublicarAnuncioDto } from './publicar-anuncio.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

describe('ListarAnunciosDto', () => {
  it.each([
    'todos',
    'mantenimiento',
    'seguridad',
    'comunidad',
    'administracion',
  ])('acepta categoria=%s', async (categoria) => {
    expect(await invalidas(ListarAnunciosDto, { categoria })).toEqual([]);
    expect(await invalidas(ListarAnunciosPortalDto, { categoria })).toEqual([]);
  });

  it.each(['todos', 'borrador', 'enviando', 'enviado', 'fallido'])(
    'acepta estado=%s en la lista de staff',
    async (estado) => {
      expect(await invalidas(ListarAnunciosDto, { estado })).toEqual([]);
    },
  );

  it('rechaza valores desconocidos (400 en vez de ignorarlos)', async () => {
    expect(
      await invalidas(ListarAnunciosDto, { categoria: 'musica' }),
    ).toContain('categoria');
    expect(await invalidas(ListarAnunciosDto, { estado: 'sent' })).toContain(
      'estado',
    );
    expect(
      await invalidas(ListarAnunciosPortalDto, { categoria: 'musica' }),
    ).toContain('categoria');
  });

  it('la lista del residente no acepta filtro de estado: no elige qué está publicado', async () => {
    const errores = await validate(
      plainToInstance(ListarAnunciosPortalDto, { estado: 'borrador' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errores.map((e) => e.property)).toContain('estado');
  });
});

describe('CrearAnuncioDto', () => {
  const valido = {
    titulo: 'Corte de agua',
    contenido: 'Sábado de 9 a 13',
    categoria: 'mantenimiento',
  };

  it('acepta un cuerpo mínimo válido e imagen null', async () => {
    expect(await invalidas(CrearAnuncioDto, valido)).toEqual([]);
    expect(
      await invalidas(CrearAnuncioDto, { ...valido, imagen: null }),
    ).toEqual([]);
  });

  it('rechaza título o contenido vacíos y categoría desconocida', async () => {
    expect(
      await invalidas(CrearAnuncioDto, { ...valido, titulo: '' }),
    ).toContain('titulo');
    expect(
      await invalidas(CrearAnuncioDto, { ...valido, contenido: '' }),
    ).toContain('contenido');
    expect(
      await invalidas(CrearAnuncioDto, { ...valido, categoria: 'otro' }),
    ).toContain('categoria');
  });

  it('el autor no es un campo del DTO: el pipe global (forbidNonWhitelisted) lo rechaza', async () => {
    const errores = await validate(
      plainToInstance(CrearAnuncioDto, { ...valido, autor: 'Otra persona' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errores.map((e) => e.property)).toContain('autor');
  });
});

describe('ActualizarAnuncioDto', () => {
  it('acepta un cuerpo parcial y vacío, y rechaza una categoría desconocida', async () => {
    expect(await invalidas(ActualizarAnuncioDto, {})).toEqual([]);
    expect(
      await invalidas(ActualizarAnuncioDto, { imagen: null, destacado: true }),
    ).toEqual([]);
    expect(
      await invalidas(ActualizarAnuncioDto, { categoria: 'otro' }),
    ).toContain('categoria');
  });

  it('no permite cambiar el autor', async () => {
    const errores = await validate(
      plainToInstance(ActualizarAnuncioDto, { autor: 'x' }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errores.map((e) => e.property)).toContain('autor');
  });
});

describe('PublicarAnuncioDto', () => {
  it('acepta un cuerpo vacío y el canal email', async () => {
    expect(await invalidas(PublicarAnuncioDto, {})).toEqual([]);
    expect(await invalidas(PublicarAnuncioDto, { canales: ['email'] })).toEqual(
      [],
    );
  });

  it.each(['sms', 'whatsapp', 'push'])(
    'rechaza el canal %s que nunca estuvo cableado (400, no se ignora en silencio)',
    async (canal) => {
      expect(
        await invalidas(PublicarAnuncioDto, { canales: ['email', canal] }),
      ).toContain('canales');
    },
  );

  it('rechaza canales repetidos y rolesDestino (nunca filtró nada)', async () => {
    expect(
      await invalidas(PublicarAnuncioDto, { canales: ['email', 'email'] }),
    ).toContain('canales');
    const errores = await validate(
      plainToInstance(PublicarAnuncioDto, { rolesDestino: ['x'] }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errores.map((e) => e.property)).toContain('rolesDestino');
  });
});
