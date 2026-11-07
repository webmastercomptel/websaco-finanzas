import type { ConfigService } from '@nestjs/config';
import { HealthCheckError } from '@nestjs/terminus';
import {
  CorreoHealthIndicator,
  MOTIVO_CORREO_DESHABILITADO,
  problemasConfiguracionCorreo,
} from './correo.health';

function indicador(valores: Record<string, string | undefined>) {
  const config = {
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService;
  return new CorreoHealthIndicator(config);
}

describe('problemasConfiguracionCorreo', () => {
  it('no reporta nada con clave y remitente válidos', () => {
    expect(
      problemasConfiguracionCorreo('SG.x', 'notificaciones@ejemplo.com'),
    ).toEqual([]);
  });

  it('nombra SENDGRID_FROM_EMAIL cuando hay clave sin remitente', () => {
    expect(problemasConfiguracionCorreo('SG.x', undefined)).toEqual([
      expect.stringContaining('SENDGRID_FROM_EMAIL'),
    ]);
  });

  it('nombra SENDGRID_API_KEY cuando hay remitente sin clave', () => {
    expect(problemasConfiguracionCorreo(undefined, 'a@ejemplo.com')).toEqual([
      expect.stringContaining('SENDGRID_API_KEY'),
    ]);
  });

  it('rechaza un remitente que no es un correo, sin repetir su valor', () => {
    const problemas = problemasConfiguracionCorreo('SG.x', 'no-es-correo');

    expect(problemas).toEqual([expect.stringContaining('SENDGRID_FROM_EMAIL')]);
    expect(problemas.join(' ')).not.toContain('no-es-correo');
  });
});

describe('CorreoHealthIndicator', () => {
  it('sin correo configurado queda arriba y omitido', () => {
    expect(indicador({}).check('correo')).toEqual({
      correo: { status: 'up', omitido: MOTIVO_CORREO_DESHABILITADO },
    });
  });

  it('con la configuración completa queda arriba', () => {
    const resultado = indicador({
      'app.sendgridApiKey': 'SG.x',
      'app.sendgridFromEmail': 'notificaciones@ejemplo.com',
    }).check('correo');

    expect(resultado).toEqual({ correo: { status: 'up' } });
  });

  it('con la configuración a medias falla nombrando el ajuste y no filtra la clave', () => {
    const alta = () =>
      indicador({ 'app.sendgridApiKey': 'SG.secreta' }).check('correo');

    expect(alta).toThrow(HealthCheckError);
    try {
      alta();
    } catch (error) {
      const mensaje = (error as HealthCheckError).message;
      expect(mensaje).toContain('SENDGRID_FROM_EMAIL');
      expect(mensaje).not.toContain('SG.secreta');
    }
  });
});
