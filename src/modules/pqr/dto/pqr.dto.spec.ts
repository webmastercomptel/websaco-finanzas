import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarPqrDto } from './actualizar-pqr.dto';
import { CrearAdjuntoPqrDto } from './guardar-adjunto.dto';
import { CrearPqrDto } from './guardar-pqr.dto';
import { CrearPqrPortalDto } from './guardar-pqr-portal.dto';
import { CrearSeguimientoDto } from './guardar-seguimiento.dto';
import { ListarPqrDto } from './listar-pqr.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

describe('ListarPqrDto', () => {
  it.each([
    'todos',
    'peticiones',
    'quejas',
    'reclamos',
    'sugerencias',
    'felicitaciones',
    'denuncias',
  ])('acepta tipo=%s', async (tipo) => {
    expect(await invalidas(ListarPqrDto, { tipo })).toEqual([]);
  });

  it.each([
    'todos',
    'urgente',
    'en_revision',
    'pendiente',
    'resuelto',
    'cerrado',
  ])('acepta estado=%s', async (estado) => {
    expect(await invalidas(ListarPqrDto, { estado })).toEqual([]);
  });

  it('rechaza valores desconocidos (400 en vez de ignorarlos)', async () => {
    expect(await invalidas(ListarPqrDto, { tipo: 'chismes' })).toContain(
      'tipo',
    );
    expect(await invalidas(ListarPqrDto, { estado: 'open' })).toContain(
      'estado',
    );
  });
});

describe('CrearPqrPortalDto (residente)', () => {
  const valido = { titulo: 'T', descripcion: 'D', tipo: 'quejas' };

  it('acepta un cuerpo mínimo, con unidad y con la prioridad heredada urgente', async () => {
    expect(await invalidas(CrearPqrPortalDto, valido)).toEqual([]);
    expect(
      await invalidas(CrearPqrPortalDto, {
        ...valido,
        unidad: 'A-101',
        prioridad: 'urgente',
      }),
    ).toEqual([]);
  });

  it('rechaza título o descripción vacíos, tipo desconocido y prioridad inventada', async () => {
    const malas = await invalidas(CrearPqrPortalDto, {
      titulo: '',
      descripcion: '',
      tipo: 'chismes',
      prioridad: 'critica',
    });

    expect(malas).toEqual(
      expect.arrayContaining(['titulo', 'descripcion', 'tipo', 'prioridad']),
    );
  });
});

describe('CrearPqrDto (personal)', () => {
  const valido = { titulo: 'T', descripcion: 'D', tipo: 'quejas' };

  it('acepta estado inicial y reportante en texto libre', async () => {
    expect(
      await invalidas(CrearPqrDto, {
        ...valido,
        estado: 'en_revision',
        residenteNombre: 'Marta',
        residenteRol: 'Arrendatario',
      }),
    ).toEqual([]);
  });

  it('no deja crear una PQR ya cerrada', async () => {
    expect(
      await invalidas(CrearPqrDto, { ...valido, estado: 'cerrado' }),
    ).toEqual(['estado']);
  });
});

describe('ActualizarPqrDto', () => {
  it('acepta cuerpo vacío, estados asignables, prioridades y tecnicoId null', async () => {
    expect(await invalidas(ActualizarPqrDto, {})).toEqual([]);
    expect(
      await invalidas(ActualizarPqrDto, {
        estado: 'resuelto',
        prioridad: 'media',
        tecnicoId: null,
      }),
    ).toEqual([]);
    expect(
      await invalidas(ActualizarPqrDto, {
        tecnicoId: '66b1f1f1f1f1f1f1f1f1f1f1',
      }),
    ).toEqual([]);
  });

  it('solo el barrido nocturno cierra: cerrado no es un estado asignable', async () => {
    expect(await invalidas(ActualizarPqrDto, { estado: 'cerrado' })).toEqual([
      'estado',
    ]);
  });

  it('rechaza un tecnicoId que no es un id de Mongo', async () => {
    expect(await invalidas(ActualizarPqrDto, { tecnicoId: 'abc' })).toEqual([
      'tecnicoId',
    ]);
  });
});

describe('CrearSeguimientoDto', () => {
  it('exige un mensaje no vacío', async () => {
    expect(await invalidas(CrearSeguimientoDto, { mensaje: 'Hola' })).toEqual(
      [],
    );
    expect(await invalidas(CrearSeguimientoDto, { mensaje: '' })).toEqual([
      'mensaje',
    ]);
  });
});

describe('CrearAdjuntoPqrDto', () => {
  it('acepta un archivo declarado y rechaza tamaño 0 o nombre vacío', async () => {
    expect(
      await invalidas(CrearAdjuntoPqrDto, {
        nombre: 'a.pdf',
        mimeType: 'application/pdf',
        tamanoBytes: 10,
      }),
    ).toEqual([]);
    expect(
      await invalidas(CrearAdjuntoPqrDto, {
        nombre: '',
        mimeType: 'application/pdf',
        tamanoBytes: 0,
      }),
    ).toEqual(expect.arrayContaining(['nombre', 'tamanoBytes']));
  });
});

describe('CrearAdjuntoPqrDto — tipos permitidos', () => {
  it.each(['text/html', 'image/svg+xml', 'application/javascript', 'text/xml'])(
    'rechaza %s (podría ejecutarse al abrirse desde el bucket)',
    async (mimeType) => {
      expect(
        await invalidas(CrearAdjuntoPqrDto, {
          nombre: 'x',
          mimeType,
          tamanoBytes: 10,
        }),
      ).toEqual(['mimeType']);
    },
  );

  it.each([
    'image/jpeg',
    'image/png',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ])('acepta %s', async (mimeType) => {
    expect(
      await invalidas(CrearAdjuntoPqrDto, {
        nombre: 'x',
        mimeType,
        tamanoBytes: 10,
      }),
    ).toEqual([]);
  });
});
