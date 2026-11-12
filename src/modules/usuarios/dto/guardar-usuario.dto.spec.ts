import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrearUsuarioDto } from './guardar-usuario.dto';

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
