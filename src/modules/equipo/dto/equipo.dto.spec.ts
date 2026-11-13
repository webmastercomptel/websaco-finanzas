import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ActualizarMiembroEquipoDto,
  CrearMiembroEquipoDto,
} from './guardar-miembro.dto';
import { ListarEquipoDto } from './listar-equipo.dto';
import {
  MAX_CLAVES_ASIGNABLES,
  PERMISOS_ADMINISTRACION,
  PERMISOS_FINANZAS,
} from '../../casl/permisos-catalogo';

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

const ROL = 'a'.repeat(24);
const valido = {
  nombre: 'Ana Pérez',
  email: 'ana@correo.co',
  rolIds: [ROL],
  permisos: ['tareas.ver'],
};

describe('CrearMiembroEquipoDto', () => {
  it('acepta una petición completa', async () => {
    expect(await errores(CrearMiembroEquipoDto, valido)).toEqual([]);
  });

  it('el nombre es obligatorio y no puede ser solo espacios', async () => {
    expect(
      await errores(CrearMiembroEquipoDto, { ...valido, nombre: '' }),
    ).toContain('nombre');
    expect(
      await errores(CrearMiembroEquipoDto, { ...valido, nombre: '   ' }),
    ).toContain('nombre');
  });

  it('exige un correo válido y lo normaliza a minúsculas sin espacios', async () => {
    expect(
      await errores(CrearMiembroEquipoDto, { ...valido, email: 'no-correo' }),
    ).toContain('email');
    const dto = plainToInstance(CrearMiembroEquipoDto, {
      ...valido,
      email: '  ANA@Correo.CO ',
    });
    expect(dto.email).toBe('ana@correo.co');
  });

  it.each([
    'perfil',
    'alcance',
    'copropiedadId',
    'entidadId',
    'esAdministradorPlataforma',
    'password',
    'coPropertyId',
  ])('rechaza el campo %s (400, no se ignora)', async (campo) => {
    expect(
      await errores(CrearMiembroEquipoDto, { ...valido, [campo]: 'x' }),
    ).toContain(campo);
  });

  it('rechaza roles que no son un id hexadecimal de 24 caracteres', async () => {
    expect(
      await errores(CrearMiembroEquipoDto, { ...valido, rolIds: ['abc'] }),
    ).toContain('rolIds');
    expect(
      await errores(CrearMiembroEquipoDto, {
        ...valido,
        rolIds: ['0x' + 'a'.repeat(22)],
      }),
    ).toContain('rolIds');
  });

  it('rechaza permisos que no son texto y vincularExistente no booleano', async () => {
    expect(
      await errores(CrearMiembroEquipoDto, { ...valido, permisos: [1] }),
    ).toContain('permisos');
    expect(
      await errores(CrearMiembroEquipoDto, {
        ...valido,
        vincularExistente: 'si',
      }),
    ).toContain('vincularExistente');
  });
});

describe('ActualizarMiembroEquipoDto', () => {
  it('todo es opcional', async () => {
    expect(await errores(ActualizarMiembroEquipoDto, {})).toEqual([]);
    expect(
      await errores(ActualizarMiembroEquipoDto, { permisos: [], rolIds: [] }),
    ).toEqual([]);
  });

  it('no permite cambiar correo, perfil ni estado por esta vía', async () => {
    for (const campo of ['email', 'perfil', 'estado', 'alcance']) {
      expect(
        await errores(ActualizarMiembroEquipoDto, { [campo]: 'x' }),
      ).toContain(campo);
    }
  });
});

describe('ListarEquipoDto', () => {
  it('acepta estados válidos y rechaza coPropertyId y valores desconocidos', async () => {
    expect(
      await errores(ListarEquipoDto, { estado: 'todos', buscar: 'ana' }),
    ).toEqual([]);
    expect(await errores(ListarEquipoDto, { estado: 'borrado' })).toContain(
      'estado',
    );
    expect(await errores(ListarEquipoDto, { coPropertyId: 'x' })).toContain(
      'coPropertyId',
    );
  });
});

describe.each([
  [
    'CrearMiembroEquipoDto',
    CrearMiembroEquipoDto,
    { nombre: 'Ana', email: 'a@b.co' },
  ],
  ['ActualizarMiembroEquipoDto', ActualizarMiembroEquipoDto, {}],
] as const)(
  '%s — límite de claves derivado del catálogo',
  (_nombre, clase, base) => {
    const claveN = (n: number) =>
      Array.from({ length: n }, (_, i) => `modulo${i}.ver`);

    it('acepta una petición con TODAS las claves ofrecidas más 17 `x.gestionar` que viajan de vuelta (S-D8.1)', async () => {
      const permisos = [
        ...PERMISOS_FINANZAS,
        ...PERMISOS_ADMINISTRACION.map((p) => p.id),
        ...Array.from({ length: 17 }, (_, i) => `legado${i}.gestionar`),
      ];
      expect(permisos.length).toBeLessThanOrEqual(MAX_CLAVES_ASIGNABLES);

      expect(await errores(clase, { ...base, permisos })).toEqual([]);
    });

    it('el tope es MAX_CLAVES_ASIGNABLES: ese número cabe, uno más no (S-D8.2)', async () => {
      expect(
        await errores(clase, {
          ...base,
          permisos: claveN(MAX_CLAVES_ASIGNABLES),
        }),
      ).toEqual([]);
      expect(
        await errores(clase, {
          ...base,
          permisos: claveN(MAX_CLAVES_ASIGNABLES + 1),
        }),
      ).toContain('permisos');
    });

    it('sigue limitando la longitud de cada clave a 80', async () => {
      expect(
        await errores(clase, { ...base, permisos: ['a'.repeat(81)] }),
      ).toContain('permisos');
    });
  },
);
