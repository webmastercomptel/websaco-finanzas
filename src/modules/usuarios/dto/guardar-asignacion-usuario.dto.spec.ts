import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ActualizarAsignacionUsuarioDto,
  AgregarAsignacionUsuarioDto,
} from './guardar-asignacion-usuario.dto';
import { MAX_CLAVES_ASIGNABLES } from '../../casl/permisos-catalogo';

/** Same options as the global ValidationPipe in main.ts. */
const errores = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) =>
  (
    await validate(plainToInstance(clase, plano), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

const ID = 'a'.repeat(24);

describe('AgregarAsignacionUsuarioDto', () => {
  const copropiedad = {
    alcance: 'copropiedad',
    copropiedadId: ID,
    permisos: ['facturas.ver'],
  };

  it('acepta una copropiedad con su id y claves', async () => {
    expect(await errores(AgregarAsignacionUsuarioDto, copropiedad)).toEqual([]);
  });

  it('acepta una entidad con su id', async () => {
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        alcance: 'entidad',
        entidadId: ID,
        permisos: [],
      }),
    ).toEqual([]);
  });

  it.each(['perfil', 'roleIds', 'estado'])(
    'rechaza con 400 la propiedad `%s` (lista blanca)',
    async (campo) => {
      expect(
        await errores(AgregarAsignacionUsuarioDto, {
          ...copropiedad,
          [campo]: campo === 'roleIds' ? [ID] : 'personal',
        }),
      ).toContain(campo);
    },
  );

  it('el id que corresponde al alcance es obligatorio (S-U3.11)', async () => {
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        alcance: 'entidad',
        permisos: [],
      }),
    ).toContain('entidadId');
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        alcance: 'copropiedad',
        permisos: [],
      }),
    ).toContain('copropiedadId');
  });

  it('un id que no es hexadecimal de 24 caracteres es 400', async () => {
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        ...copropiedad,
        copropiedadId: 'no-es-un-id',
      }),
    ).toContain('copropiedadId');
  });

  it('el alcance debe ser copropiedad o entidad', async () => {
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        ...copropiedad,
        alcance: 'global',
      }),
    ).toContain('alcance');
  });

  it('`permisos` es obligatorio, pero una lista vacía es válida (S-U3.14)', async () => {
    const { permisos: _omitido, ...sinPermisos } = copropiedad;
    void _omitido;
    expect(await errores(AgregarAsignacionUsuarioDto, sinPermisos)).toContain(
      'permisos',
    );
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        ...copropiedad,
        permisos: [],
      }),
    ).toEqual([]);
  });

  it('cada clave es texto de hasta 80 caracteres y la lista tiene tope', async () => {
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        ...copropiedad,
        permisos: [123],
      }),
    ).toContain('permisos');
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        ...copropiedad,
        permisos: ['a'.repeat(81)],
      }),
    ).toContain('permisos');
    expect(
      await errores(AgregarAsignacionUsuarioDto, {
        ...copropiedad,
        permisos: Array.from(
          { length: MAX_CLAVES_ASIGNABLES + 1 },
          (_, i) => `k${i}.ver`,
        ),
      }),
    ).toContain('permisos');
  });
});

describe('ActualizarAsignacionUsuarioDto', () => {
  it('un cuerpo vacío es 400 (S-U4.10)', async () => {
    expect((await errores(ActualizarAsignacionUsuarioDto, {})).length).toBe(1);
  });

  it('acepta solo permisos, solo estado, o ambos', async () => {
    expect(
      await errores(ActualizarAsignacionUsuarioDto, { permisos: [] }),
    ).toEqual([]);
    expect(
      await errores(ActualizarAsignacionUsuarioDto, { estado: 'activo' }),
    ).toEqual([]);
    expect(
      await errores(ActualizarAsignacionUsuarioDto, {
        estado: 'inactivo',
        permisos: ['pqr.ver'],
      }),
    ).toEqual([]);
  });

  it.each(['alcance', 'copropiedadId', 'entidadId', 'perfil', 'roleIds'])(
    'rechaza con 400 la propiedad `%s`: el destino es inmutable y nada cambia el perfil',
    async (campo) => {
      expect(
        await errores(ActualizarAsignacionUsuarioDto, {
          permisos: [],
          [campo]: campo === 'roleIds' ? [ID] : 'x',
        }),
      ).toContain(campo);
    },
  );

  it("`estado: 'activa'` es 400 (S-U5.10)", async () => {
    expect(
      await errores(ActualizarAsignacionUsuarioDto, { estado: 'activa' }),
    ).toContain('estado');
  });

  it('`permisos` mal formado se rechaza aunque venga junto a `estado`', async () => {
    expect(
      await errores(ActualizarAsignacionUsuarioDto, {
        estado: 'activo',
        permisos: 'facturas.ver',
      }),
    ).toContain('permisos');
    expect(
      await errores(ActualizarAsignacionUsuarioDto, {
        estado: 'activo',
        permisos: [1],
      }),
    ).toContain('permisos');
  });

  it('cada clave tiene hasta 80 caracteres y la lista tiene tope', async () => {
    expect(
      await errores(ActualizarAsignacionUsuarioDto, {
        permisos: ['a'.repeat(81)],
      }),
    ).toContain('permisos');
    expect(
      await errores(ActualizarAsignacionUsuarioDto, {
        permisos: Array.from(
          { length: MAX_CLAVES_ASIGNABLES + 1 },
          (_, i) => `k${i}.ver`,
        ),
      }),
    ).toContain('permisos');
  });
});
