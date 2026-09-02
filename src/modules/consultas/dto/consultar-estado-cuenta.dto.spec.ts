import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConsultarEstadoCuentaDto } from './consultar-estado-cuenta.dto';

const valido = () => ({
  inmuebleId: '507f1f77bcf86cd799439011',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
});

/**
 * Regression test for a real bug: `GET .../estado-cuenta/pdf` binds its
 * `?duplicado=true` query param through this SAME DTO (§4 of the PDF
 * generation spec), and the app's global ValidationPipe runs with
 * `{ whitelist: true, forbidNonWhitelisted: true }` (app-setup.ts) — a
 * property this DTO doesn't declare gets the whole request rejected with
 * 400, not just ignored. Mirrors that exact pipe config here rather than
 * the bare `validate(dto)` default, which would NOT have caught this.
 */
const validarComoElPipeGlobal = (dto: ConsultarEstadoCuentaDto) =>
  validate(dto, { whitelist: true, forbidNonWhitelisted: true });

describe('ConsultarEstadoCuentaDto', () => {
  it('acepta el mínimo bien formado', async () => {
    const dto = plainToInstance(ConsultarEstadoCuentaDto, valido());
    expect(await validarComoElPipeGlobal(dto)).toHaveLength(0);
  });

  it('acepta duplicado=true sin ser rechazada por whitelist', async () => {
    const dto = plainToInstance(ConsultarEstadoCuentaDto, {
      ...valido(),
      duplicado: 'true',
    });
    expect(await validarComoElPipeGlobal(dto)).toHaveLength(0);
  });

  it('acepta duplicado=false', async () => {
    const dto = plainToInstance(ConsultarEstadoCuentaDto, {
      ...valido(),
      duplicado: 'false',
    });
    expect(await validarComoElPipeGlobal(dto)).toHaveLength(0);
  });

  it('rechaza duplicado con un valor que no es boolean-string', async () => {
    const dto = plainToInstance(ConsultarEstadoCuentaDto, {
      ...valido(),
      duplicado: 'no-es-un-booleano',
    });
    expect(await validarComoElPipeGlobal(dto)).not.toHaveLength(0);
  });

  it('sigue rechazando una propiedad genuinamente desconocida', async () => {
    const dto = plainToInstance(ConsultarEstadoCuentaDto, {
      ...valido(),
      colado: 'no deberia entrar',
    });
    const errores = await validarComoElPipeGlobal(dto);
    expect(errores.length).toBeGreaterThan(0);
    expect(JSON.stringify(errores)).toContain('colado');
  });
});
