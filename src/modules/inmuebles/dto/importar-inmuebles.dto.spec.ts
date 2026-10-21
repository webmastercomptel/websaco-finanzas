import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FilaImportarInmuebleDto } from './importar-inmuebles.dto';

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

  it('un 0 explícito sigue siendo un 0 enviado', async () => {
    const dto = fila({ area: 0, coeficiente: '0' });

    expect(dto.area).toBe(0);
    expect(dto.coeficiente).toBe(0);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('un tipo de titular, estado de cartera o residencia en blanco no rechaza el archivo entero', async () => {
    const dto = fila({
      tipoTitular: '',
      estadoCartera: ' ',
      resideEnElInmueble: '',
    });

    expect(dto.tipoTitular).toBeUndefined();
    expect(dto.estadoCartera).toBeUndefined();
    expect(dto.resideEnElInmueble).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });

  it('un valor inválido no vacío sigue siendo rechazado', async () => {
    const dto = fila({ tipoTitular: 'inquilino' });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
