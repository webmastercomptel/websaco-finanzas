import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CrearBloqueDto } from './guardar-bloque.dto';
import { ListarBloquesDto, ListarMisDocumentosDto } from './listar-bloques.dto';

const errores = async <T extends object>(clase: new () => T, datos: object) =>
  (
    await validate(plainToInstance(clase, datos), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

const valido = {
  tipo: 'factura',
  periodo: '2026-07',
  nombre: 'a.pdf',
  mimeType: 'application/pdf',
  tamanoBytes: 1000,
};

describe('CrearBloqueDto', () => {
  it('acepta el cuerpo del paso 1', async () => {
    expect(await errores(CrearBloqueDto, valido)).toEqual([]);
  });

  it.each([
    ['tipo desconocido', { tipo: 'nota' }, 'tipo'],
    ['período vacío', { periodo: '' }, 'periodo'],
    ['período larguísimo', { periodo: 'x'.repeat(41) }, 'periodo'],
    ['nombre vacío', { nombre: '' }, 'nombre'],
    ['no es PDF', { mimeType: 'image/png' }, 'mimeType'],
    ['tamaño cero', { tamanoBytes: 0 }, 'tamanoBytes'],
    ['tamaño decimal', { tamanoBytes: 1.5 }, 'tamanoBytes'],
  ])('rechaza %s', async (_n, cambio, campo) => {
    expect(await errores(CrearBloqueDto, { ...valido, ...cambio })).toContain(
      campo,
    );
  });

  it('rechaza campos no declarados (p. ej. quién sube o la ruta)', async () => {
    expect(
      await errores(CrearBloqueDto, { ...valido, subidoPorNombre: 'x' }),
    ).toContain('subidoPorNombre');
  });

  it('acepta los tres tipos del sistema original', async () => {
    for (const tipo of ['factura', 'estado_cuenta', 'recibo']) {
      expect(await errores(CrearBloqueDto, { ...valido, tipo })).toEqual([]);
    }
  });
});

describe('ListarBloquesDto', () => {
  it('acepta sin filtros y con filtros válidos', async () => {
    expect(await errores(ListarBloquesDto, {})).toEqual([]);
    expect(
      await errores(ListarBloquesDto, {
        tipo: 'recibo',
        estado: 'pendiente_envio',
      }),
    ).toEqual([]);
  });

  it.each([
    [{ tipo: 'otro' }, 'tipo'],
    [{ estado: 'listo' }, 'estado'],
    [{ estado: 'ready' }, 'estado'],
  ])('un valor desconocido (%j) es 400', async (query, campo) => {
    expect(await errores(ListarBloquesDto, query)).toContain(campo);
  });

  it('rechaza ?coPropertyId= y ?copropiedadId=: el tenant nunca viene del cliente', async () => {
    expect(await errores(ListarBloquesDto, { coPropertyId: 'x' })).toContain(
      'coPropertyId',
    );
    expect(await errores(ListarBloquesDto, { copropiedadId: 'x' })).toContain(
      'copropiedadId',
    );
  });
});

describe('ListarMisDocumentosDto', () => {
  it('acepta factura y estado_cuenta', async () => {
    expect(await errores(ListarMisDocumentosDto, { tipo: 'factura' })).toEqual(
      [],
    );
    expect(
      await errores(ListarMisDocumentosDto, { tipo: 'estado_cuenta' }),
    ).toEqual([]);
  });

  it('un recibo no es un valor válido para un residente: 400', async () => {
    expect(await errores(ListarMisDocumentosDto, { tipo: 'recibo' })).toContain(
      'tipo',
    );
  });

  it('rechaza ?coPropertyId=', async () => {
    expect(
      await errores(ListarMisDocumentosDto, { coPropertyId: 'x' }),
    ).toContain('coPropertyId');
  });
});
