import type { ConfigService } from '@nestjs/config';
import { HealthCheckError } from '@nestjs/terminus';
import {
  diagnosticarFrontendUrl,
  FrontendUrlHealthIndicator,
  problemasFrontendUrl,
} from './frontend-url.health';

describe('problemasFrontendUrl', () => {
  it.each([
    ['un origen https', 'https://app.ejemplo.com'],
    ['un origen con barra final', 'https://app.ejemplo.com/'],
    ['un origen con puerto', 'http://localhost:5173'],
  ])('no reporta nada con %s', (_n, valor) => {
    expect(problemasFrontendUrl(valor)).toEqual([]);
    expect(diagnosticarFrontendUrl(valor)).toBeNull();
  });

  it.each([undefined, '', '   '])('reporta que falta (%j)', (valor) => {
    expect(diagnosticarFrontendUrl(valor)).toBe('falta');
    expect(problemasFrontendUrl(valor)).toEqual([
      expect.stringContaining('Falta FRONTEND_URL'),
    ]);
  });

  it.each([
    ['con ruta', 'https://app.ejemplo.com/app'],
    ['con consulta', 'https://app.ejemplo.com?x=1'],
    ['con consulta vacía', 'https://app.ejemplo.com/?'],
    ['con fragmento', 'https://app.ejemplo.com/#a'],
    ['con credenciales', 'https://usuario:clave@app.ejemplo.com'],
    ['sin esquema', 'app.ejemplo.com'],
    ['con otro esquema', 'ftp://app.ejemplo.com'],
  ])('reporta que está mal formada %s, sin repetir el valor', (_n, valor) => {
    expect(diagnosticarFrontendUrl(valor)).toBe('malformada');
    const problemas = problemasFrontendUrl(valor);
    expect(problemas).toEqual([expect.stringContaining('FRONTEND_URL')]);
    expect(problemas.join(' ')).not.toContain(valor);
    expect(problemas.join(' ')).not.toContain('clave');
  });
});

describe('FrontendUrlHealthIndicator', () => {
  const indicador = (valores: Record<string, string | undefined>) =>
    new FrontendUrlHealthIndicator({
      get: (clave: string) => valores[clave],
    } as unknown as ConfigService);

  const CORREO = {
    'app.sendgridApiKey': 'SG.x',
    'app.sendgridFromEmail': 'n@ejemplo.com',
  };

  it('con el correo sin configurar queda arriba y omitido', () => {
    expect(indicador({}).check('frontend-url')).toEqual({
      'frontend-url': { status: 'up', omitido: 'correo no configurado' },
    });
  });

  it('con correo y un origen válido queda arriba', () => {
    expect(
      indicador({
        ...CORREO,
        'app.frontendUrl': 'https://app.ejemplo.com',
      }).check('frontend-url'),
    ).toEqual({ 'frontend-url': { status: 'up' } });
  });

  it.each([
    ['falta', undefined],
    ['lleva ruta', 'https://app.ejemplo.com/app'],
  ])(
    'con correo y FRONTEND_URL que %s cae nombrando el ajuste y sin repetir el valor',
    (_n, valor) => {
      const alta = () =>
        indicador({ ...CORREO, 'app.frontendUrl': valor }).check(
          'frontend-url',
        );

      expect(alta).toThrow(HealthCheckError);
      try {
        alta();
      } catch (error) {
        const mensaje = (error as HealthCheckError).message;
        expect(mensaje).toContain('FRONTEND_URL');
        expect(mensaje).not.toContain('ejemplo.com');
      }
    },
  );
});
