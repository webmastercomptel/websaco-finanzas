import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AprovisionarResidentesDto } from './aprovisionar-residentes.dto';
import { CrearAccesoResidenteDto } from './crear-acceso-residente.dto';
import { ListarResidentesDto } from './listar-residentes.dto';

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

describe('ListarResidentesDto', () => {
  it('acepta filtros válidos', async () => {
    expect(
      await errores(ListarResidentesDto, {
        buscar: 'ana',
        estadoAcceso: 'sinCuenta',
        pagina: '2',
        porPagina: '50',
      }),
    ).toEqual([]);
  });

  it('rechaza coPropertyId, estados desconocidos y páginas fuera de rango', async () => {
    expect(await errores(ListarResidentesDto, { coPropertyId: 'x' })).toContain(
      'coPropertyId',
    );
    expect(
      await errores(ListarResidentesDto, { estadoAcceso: 'invitado' }),
    ).toContain('estadoAcceso');
    expect(await errores(ListarResidentesDto, { porPagina: '9999' })).toContain(
      'porPagina',
    );
  });
});

describe('CrearAccesoResidenteDto', () => {
  it('acepta vincularExistente booleano o ausente', async () => {
    expect(await errores(CrearAccesoResidenteDto, {})).toEqual([]);
    expect(
      await errores(CrearAccesoResidenteDto, { vincularExistente: true }),
    ).toEqual([]);
  });

  it('no acepta un correo propio (la dirección sale del tercero) ni valores no booleanos', async () => {
    expect(
      await errores(CrearAccesoResidenteDto, { email: 'x@y.co' }),
    ).toContain('email');
    expect(
      await errores(CrearAccesoResidenteDto, { vincularExistente: 'si' }),
    ).toContain('vincularExistente');
  });
});

describe('AprovisionarResidentesDto', () => {
  it('acepta cursor válido y límite hasta 25', async () => {
    expect(
      await errores(AprovisionarResidentesDto, {
        desde: 'a'.repeat(24),
        limite: 25,
      }),
    ).toEqual([]);
    expect(await errores(AprovisionarResidentesDto, {})).toEqual([]);
  });

  it('rechaza límite mayor a 25, cursor inválido y campos desconocidos', async () => {
    expect(await errores(AprovisionarResidentesDto, { limite: 26 })).toContain(
      'limite',
    );
    expect(await errores(AprovisionarResidentesDto, { limite: 0 })).toContain(
      'limite',
    );
    expect(
      await errores(AprovisionarResidentesDto, {
        desde: '0x' + 'a'.repeat(22),
      }),
    ).toContain('desde');
    expect(
      await errores(AprovisionarResidentesDto, { password: '123456' }),
    ).toContain('password');
  });
});
