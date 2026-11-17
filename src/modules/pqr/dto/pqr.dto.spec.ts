import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarPqrDto } from './actualizar-pqr.dto';
import { CrearAdjuntoPqrDto } from './guardar-adjunto.dto';
import { CerrarPqrDto } from './cerrar-pqr.dto';
import { ClasificarPqrDto } from './clasificar-pqr.dto';
import { CrearPqrDto } from './guardar-pqr.dto';
import { CrearTareaPqrDto } from './guardar-tarea-pqr.dto';
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
    'radicada',
    'clasificada',
    'en_gestion',
    'cerrada',
    'urgente',
    'en_revision',
    'pendiente',
    'resuelto',
    'cerrado',
  ])('acepta estado=%s', async (estado) => {
    expect(await invalidas(ListarPqrDto, { estado })).toEqual([]);
  });

  it('vencidas acepta true/false como texto y rechaza otra cosa', async () => {
    expect(await invalidas(ListarPqrDto, { vencidas: 'true' })).toEqual([]);
    expect(await invalidas(ListarPqrDto, { vencidas: 'false' })).toEqual([]);
    expect(await invalidas(ListarPqrDto, { vencidas: 'quizas' })).toEqual([
      'vencidas',
    ]);
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

  it('acepta (e ignora) un estado legado para no dar 400 a una pestaña vieja', async () => {
    expect(
      await invalidas(CrearPqrDto, { ...valido, estado: 'pendiente' }),
    ).toEqual([]);
    expect(
      await invalidas(CrearPqrDto, { ...valido, estado: 'cerrado' }),
    ).toEqual([]);
  });

  it('rechaza un estado inventado', async () => {
    expect(
      await invalidas(CrearPqrDto, { ...valido, estado: 'abierta' }),
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

  it('acepta las etapas y los valores legados (la regla la decide el servicio)', async () => {
    for (const estado of ['en_gestion', 'cerrada', 'cerrado', 'urgente']) {
      expect(await invalidas(ActualizarPqrDto, { estado })).toEqual([]);
    }
    expect(await invalidas(ActualizarPqrDto, { estado: 'abierta' })).toEqual([
      'estado',
    ]);
  });

  it('rechaza un tecnicoId que no es un id de Mongo', async () => {
    expect(await invalidas(ActualizarPqrDto, { tecnicoId: 'abc' })).toEqual([
      'tecnicoId',
    ]);
  });
});

describe('ClasificarPqrDto', () => {
  const valido = {
    tipo: 'quejas',
    responsable: 'consejo',
    fechaLimite: '2026-12-09',
  };

  it('acepta un cuerpo válido', async () => {
    expect(await invalidas(ClasificarPqrDto, valido)).toEqual([]);
  });

  it('rechaza una fecha que no existe en el calendario', async () => {
    expect(
      await invalidas(ClasificarPqrDto, {
        ...valido,
        fechaLimite: '2026-02-30',
      }),
    ).toContain('fechaLimite');
  });

  it('rechaza una fecha con hora o con otro formato', async () => {
    for (const fechaLimite of ['2026-12-09T10:00:00Z', '09/12/2026']) {
      expect(
        await invalidas(ClasificarPqrDto, { ...valido, fechaLimite }),
      ).toContain('fechaLimite');
    }
  });

  it('rechaza un responsable o un tipo desconocidos', async () => {
    expect(
      await invalidas(ClasificarPqrDto, { ...valido, responsable: 'vecinos' }),
    ).toEqual(['responsable']);
    expect(
      await invalidas(ClasificarPqrDto, { ...valido, tipo: 'chismes' }),
    ).toEqual(['tipo']);
  });
});

describe('CerrarPqrDto', () => {
  it('exige un mensaje no vacío de a lo sumo 5000 caracteres', async () => {
    expect(await invalidas(CerrarPqrDto, { mensaje: 'Resuelto' })).toEqual([]);
    expect(await invalidas(CerrarPqrDto, { mensaje: '' })).toEqual(['mensaje']);
    expect(await invalidas(CerrarPqrDto, { mensaje: '   ' })).toEqual([
      'mensaje',
    ]);
    expect(
      await invalidas(CerrarPqrDto, { mensaje: 'x'.repeat(5001) }),
    ).toEqual(['mensaje']);
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

describe('CrearTareaPqrDto', () => {
  const valida = {
    titulo: 'Revisar',
    asignadosIds: [new Types.ObjectId().toString()],
  };

  it('acepta el mínimo', async () => {
    expect(await invalidas(CrearTareaPqrDto, valida)).toEqual([]);
  });

  it('rechaza asignadosIds vacío con el mensaje en español', async () => {
    const errores = await validate(
      plainToInstance(CrearTareaPqrDto, { ...valida, asignadosIds: [] }),
    );
    expect(errores[0].constraints?.arrayMinSize).toBe(
      'Elige al menos un colaborador.',
    );
  });

  it('rechaza colaboradores repetidos con el mensaje en español', async () => {
    const id = new Types.ObjectId().toString();
    const errores = await validate(
      plainToInstance(CrearTareaPqrDto, { ...valida, asignadosIds: [id, id] }),
    );
    expect(errores[0].constraints?.arrayUnique).toBe(
      'Hay colaboradores repetidos.',
    );
  });

  it('rechaza asignadosIds ausente con el mensaje en español', async () => {
    const errores = await validate(
      plainToInstance(CrearTareaPqrDto, { titulo: 'Revisar' }),
    );
    expect(errores[0].constraints?.isArray).toBe(
      'Elige al menos un colaborador.',
    );
  });

  it.each([
    { titulo: '' },
    { titulo: 'x'.repeat(201) },
    { descripcion: 'x'.repeat(5001) },
    { categoria: 'otra' },
    { asignadosIds: ['no-id'] },
    { fechaLimite: 'mañana' },
  ])('rechaza %j', async (cambio) => {
    const malas = await invalidas(CrearTareaPqrDto, { ...valida, ...cambio });
    expect(malas.length).toBeGreaterThan(0);
  });
});
