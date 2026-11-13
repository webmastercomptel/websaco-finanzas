import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AccionResidenteCorreoDto } from './accion-residente-correo.dto';
import { ListarResidentesCorreosDto } from './listar-residentes-correos.dto';

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
const CLAVE = 'b'.repeat(64);

describe('ListarResidentesCorreosDto', () => {
  it('acepta buscar, estado, pagina y porPagina', async () => {
    expect(
      await errores(ListarResidentesCorreosDto, {
        buscar: 'ana',
        estado: 'revocado',
        pagina: '2',
        porPagina: '50',
      }),
    ).toEqual([]);
    expect(await errores(ListarResidentesCorreosDto, {})).toEqual([]);
  });

  it('rechaza estados desconocidos, páginas fuera de rango y propiedades extra', async () => {
    expect(
      await errores(ListarResidentesCorreosDto, { estado: 'invitado' }),
    ).toContain('estado');
    expect(
      await errores(ListarResidentesCorreosDto, { porPagina: '9999' }),
    ).toContain('porPagina');
    expect(
      await errores(ListarResidentesCorreosDto, { pagina: '0' }),
    ).toContain('pagina');
    expect(
      await errores(ListarResidentesCorreosDto, { coPropertyId: 'x' }),
    ).toContain('coPropertyId');
  });
});

describe('AccionResidenteCorreoDto', () => {
  it('acepta un terceroId de 24 hex y una clave de 64 hex', async () => {
    expect(
      await errores(AccionResidenteCorreoDto, { terceroId: ID, clave: CLAVE }),
    ).toEqual([]);
  });

  it('rechaza un id con prefijo 0x, una clave corta o con mayúsculas y la falta de campos', async () => {
    expect(
      await errores(AccionResidenteCorreoDto, {
        terceroId: `0x${'a'.repeat(22)}`,
        clave: CLAVE,
      }),
    ).toContain('terceroId');
    expect(
      await errores(AccionResidenteCorreoDto, {
        terceroId: ID,
        clave: 'b'.repeat(63),
      }),
    ).toContain('clave');
    expect(
      await errores(AccionResidenteCorreoDto, {
        terceroId: ID,
        clave: 'B'.repeat(64),
      }),
    ).toContain('clave');
    expect(await errores(AccionResidenteCorreoDto, {})).toEqual(
      expect.arrayContaining(['terceroId', 'clave']),
    );
  });

  it('no acepta un correo en el cuerpo: la dirección sale de la ficha', async () => {
    expect(
      await errores(AccionResidenteCorreoDto, {
        terceroId: ID,
        clave: CLAVE,
        correo: 'a@x.co',
      }),
    ).toContain('correo');
  });
});
