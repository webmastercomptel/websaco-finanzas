import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConsultarConciliacionCarteraDto } from './consultar-conciliacion-cartera.dto';

const valido = () => ({
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
});

/** Mirrors the app's global ValidationPipe config — see the identical note
 *  on `ConsultarEstadoCuentaDto`'s own spec. */
const validarComoElPipeGlobal = (dto: ConsultarConciliacionCarteraDto) =>
  validate(dto, { whitelist: true, forbidNonWhitelisted: true });

describe('ConsultarConciliacionCarteraDto', () => {
  it('acepta el mínimo bien formado', async () => {
    const dto = plainToInstance(ConsultarConciliacionCarteraDto, valido());
    expect(await validarComoElPipeGlobal(dto)).toHaveLength(0);
  });

  it('rechaza cuando falta periodStart', async () => {
    const dto = plainToInstance(ConsultarConciliacionCarteraDto, {
      periodEnd: '2026-08-31',
    });
    expect(await validarComoElPipeGlobal(dto)).not.toHaveLength(0);
  });

  it('rechaza cuando falta periodEnd', async () => {
    const dto = plainToInstance(ConsultarConciliacionCarteraDto, {
      periodStart: '2026-08-01',
    });
    expect(await validarComoElPipeGlobal(dto)).not.toHaveLength(0);
  });

  it('rechaza una fecha mal formada', async () => {
    const dto = plainToInstance(ConsultarConciliacionCarteraDto, {
      ...valido(),
      periodStart: 'no-es-una-fecha',
    });
    expect(await validarComoElPipeGlobal(dto)).not.toHaveLength(0);
  });

  it('rechaza una propiedad genuinamente desconocida', async () => {
    const dto = plainToInstance(ConsultarConciliacionCarteraDto, {
      ...valido(),
      colado: 'no deberia entrar',
    });
    const errores = await validarComoElPipeGlobal(dto);
    expect(errores.length).toBeGreaterThan(0);
    expect(JSON.stringify(errores)).toContain('colado');
  });
});
