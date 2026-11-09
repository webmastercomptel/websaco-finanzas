import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  FilaImportarInmuebleDto,
  ImportarInmueblesDto,
} from './importar-inmuebles.dto';

/** The exact pipe `app-setup.ts` installs globally. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const pasarPorPipe = (fila: Record<string, unknown>) =>
  pipe.transform(
    { filas: [{ codigoCopropiedad: '0001', codigo: '301', ...fila }] },
    { type: 'body', metatype: ImportarInmueblesDto },
  ) as Promise<ImportarInmueblesDto>;

const fila = (over: Record<string, unknown> = {}) =>
  plainToInstance(FilaImportarInmuebleDto, {
    codigoCopropiedad: '0001',
    codigo: '301',
    ...over,
  });

describe('FilaImportarInmuebleDto — celdas en blanco', () => {
  it('un área o coeficiente en blanco queda sin enviar, no como 0 que pisaría el valor guardado', async () => {
    const dto = fila({ area: '', coeficiente: '   ' });

    expect(dto.area).toBeUndefined();
    expect(dto.coeficiente).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('un null (área, coeficiente, estado de cartera) también queda sin enviar', async () => {
    const dto = fila({
      area: null,
      coeficiente: null,
      estadoCartera: null,
    });

    expect(dto.area).toBeUndefined();
    expect(dto.coeficiente).toBeUndefined();
    expect(dto.estadoCartera).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('un 0 explícito sigue siendo un 0 enviado', async () => {
    const dto = fila({ area: 0, coeficiente: '0' });

    expect(dto.area).toBe(0);
    expect(dto.coeficiente).toBe(0);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('un estado de cartera en blanco no rechaza el archivo entero', async () => {
    const dto = fila({ estadoCartera: ' ' });

    expect(dto.estadoCartera).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('un valor inválido no vacío sigue siendo rechazado', async () => {
    const dto = fila({ estadoCartera: 'moroso' });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});

describe('FilaImportarInmuebleDto — columnas retiradas', () => {
  it('un archivo viejo con la columna resideEnElInmueble se acepta (sin 400) y el valor se descarta', async () => {
    const dto = await pasarPorPipe({
      resideEnElInmueble: true,
      zona: 'Norte',
    });

    expect(dto.filas[0].zona).toBe('Norte');
    expect(dto.filas[0].resideEnElInmueble).toBeUndefined();
  });

  it('el valor de una columna retirada no se valida: incluso basura se acepta y se ignora', async () => {
    const dto = await pasarPorPipe({ resideEnElInmueble: 'quizás' });

    expect(dto.filas[0].resideEnElInmueble).toBeUndefined();
  });

  it('una propiedad desconocida cualquiera sigue siendo rechazada (el pipe global no se relajó)', async () => {
    await expect(
      pasarPorPipe({ columnaInventada: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
