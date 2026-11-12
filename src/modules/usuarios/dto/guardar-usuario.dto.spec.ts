import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarUsuarioDto, CrearUsuarioDto } from './guardar-usuario.dto';

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
/** `@IsMongoId` accepts this (a `0x` prefix plus 22 hex), `new ObjectId` throws on it. */
const ID_CON_PREFIJO = `0x${'a'.repeat(22)}`;

describe('CrearUsuarioDto — destino de la primera asignación', () => {
  const base = {
    nombre: 'Ana',
    email: 'ana@ejemplo.com',
    password: 'clave123',
  };

  it('acepta una copropiedad y una entidad con id hexadecimal de 24 caracteres', async () => {
    expect(
      await errores(CrearUsuarioDto, {
        ...base,
        alcance: 'copropiedad',
        copropiedadId: ID,
      }),
    ).toEqual([]);
    expect(
      await errores(CrearUsuarioDto, {
        ...base,
        alcance: 'entidad',
        entidadId: ID,
      }),
    ).toEqual([]);
  });

  it('un copropiedadId con prefijo 0x es 400, no un 500 al construir el ObjectId', async () => {
    expect(
      await errores(CrearUsuarioDto, {
        ...base,
        alcance: 'copropiedad',
        copropiedadId: ID_CON_PREFIJO,
      }),
    ).toContain('copropiedadId');
  });

  it('un entidadId con prefijo 0x es 400, no un 500 al construir el ObjectId', async () => {
    expect(
      await errores(CrearUsuarioDto, {
        ...base,
        alcance: 'entidad',
        entidadId: ID_CON_PREFIJO,
      }),
    ).toContain('entidadId');
  });
});

describe('CrearUsuarioDto — perfil', () => {
  const base = {
    nombre: 'Ana',
    email: 'ana@ejemplo.com',
    password: 'clave123',
    alcance: 'copropiedad',
    copropiedadId: ID,
  };

  it('`perfil` es 400: Usuarios solo escribe filas administrativas (S-X1.8)', async () => {
    expect(
      await errores(CrearUsuarioDto, { ...base, perfil: 'personal' }),
    ).toContain('perfil');
    expect(
      await errores(CrearUsuarioDto, { ...base, perfil: 'administrativo' }),
    ).toContain('perfil');
  });

  it('sin `perfil` el cuerpo sigue siendo válido', async () => {
    expect(
      await errores(CrearUsuarioDto, { ...base, permisos: ['pqr.ver'] }),
    ).toEqual([]);
  });
});

describe('ActualizarUsuarioDto — solo la cuenta (REQ-X1)', () => {
  it('acepta nombre, esAdministradorPlataforma, estado y nuevaPassword', async () => {
    expect(
      await errores(ActualizarUsuarioDto, {
        nombre: 'Ana P.',
        esAdministradorPlataforma: false,
        estado: 'inactivo',
        nuevaPassword: 'otra123',
      }),
    ).toEqual([]);
    expect(await errores(ActualizarUsuarioDto, { nombre: 'Ana' })).toEqual([]);
    expect(await errores(ActualizarUsuarioDto, {})).toEqual([]);
  });

  it.each([
    ['alcance', 'copropiedad'],
    ['copropiedadId', ID],
    ['entidadId', ID],
    ['permisos', ['facturas.ver']],
    ['perfil', 'personal'],
  ])(
    'rechaza con 400 `%s`: los accesos se gestionan en /usuarios/:id/asignaciones (S-X1.3 a S-X1.5)',
    async (campo, valor) => {
      expect(
        await errores(ActualizarUsuarioDto, { nombre: 'Ana', [campo]: valor }),
      ).toContain(campo);
    },
  );

  it('`nuevaPassword` de 5 caracteres es 400 (S-X1.6)', async () => {
    expect(
      await errores(ActualizarUsuarioDto, { nuevaPassword: '12345' }),
    ).toContain('nuevaPassword');
  });
});
