import { HealthCheckError } from '@nestjs/terminus';
import {
  IntegracionComptableHealthIndicator,
  MOTIVO_INTEGRACION_DESHABILITADA,
  problemasConfiguracionComptable,
} from './integracion-comptable.health';

const URL_OK = 'https://comptable.ejemplo.com/api/v1';
const SECRETO = 'comptable-test-secret-0123456789abcdef';

const indicadorCon = (url?: string, secreto?: string) =>
  new IntegracionComptableHealthIndicator({
    get: jest.fn((clave: string) =>
      clave === 'app.comptableApiUrl'
        ? url
        : clave === 'app.comptableHmacSecret'
          ? secreto
          : undefined,
    ),
  } as never);

/** The failure the indicator throws, as terminus will render it. */
function fallo(indicador: IntegracionComptableHealthIndicator) {
  try {
    indicador.check('integracion-comptable');
  } catch (error) {
    expect(error).toBeInstanceOf(HealthCheckError);
    return error as HealthCheckError;
  }
  throw new Error('se esperaba que el indicador fallara');
}

const mensajeDe = (error: HealthCheckError): string => {
  const causas = error.causes as Record<string, unknown>;
  return (causas['integracion-comptable'] as { message: string }).message;
};

describe('problemasConfiguracionComptable', () => {
  it.each([
    'https://comptable.ejemplo.com/api/v1',
    'https://comptable.ejemplo.com/api/v1/',
    'https://comptable.ejemplo.com/api/v1///',
    'https://gateway.ejemplo.com/comptable/api/v1',
    'http://localhost:3001/api/v1',
  ])('no ve problemas en %s con el secreto definido', (url) => {
    expect(problemasConfiguracionComptable(url, SECRETO)).toEqual([]);
  });

  it.each([
    'https://comptable.ejemplo.com',
    'https://comptable.ejemplo.com/',
    'https://comptable.ejemplo.com/api',
    'https://comptable.ejemplo.com/api/v2',
    'https://comptable.ejemplo.com/api/v1/integraciones',
  ])('detecta que %s no termina en /api/v1', (url) => {
    const problemas = problemasConfiguracionComptable(url, SECRETO);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(
      /COMPTABLE_API_URL debe terminar en \/api\/v1/,
    );
  });

  it('detecta la URL definida sin el secreto', () => {
    const problemas = problemasConfiguracionComptable(URL_OK, undefined);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(/Falta COMPTABLE_HMAC_SECRET/);
  });

  it('detecta el secreto definido sin la URL', () => {
    const problemas = problemasConfiguracionComptable(undefined, SECRETO);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(/Falta COMPTABLE_API_URL/);
  });

  it('trata la cadena vacía como no definida', () => {
    expect(problemasConfiguracionComptable('', SECRETO)[0]).toMatch(
      /Falta COMPTABLE_API_URL/,
    );
    expect(problemasConfiguracionComptable(URL_OK, '')[0]).toMatch(
      /Falta COMPTABLE_HMAC_SECRET/,
    );
  });

  it.each(['comptable.ejemplo.com/api/v1', 'no es una url', 'ftp://h/api/v1'])(
    'detecta que %p no es una URL http(s) válida',
    (url) => {
      const problemas = problemasConfiguracionComptable(url, SECRETO);

      expect(problemas).toHaveLength(1);
      expect(problemas[0]).toMatch(/no es una URL http\(s\) válida/);
    },
  );

  it('detecta credenciales dentro de la URL', () => {
    const problemas = problemasConfiguracionComptable(
      'https://usuario:clave@comptable.ejemplo.com/api/v1',
      SECRETO,
    );

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(/usuario ni contraseña/);
  });

  it.each([
    'https://comptable.ejemplo.com/api/v1?x=1',
    'https://comptable.ejemplo.com/api/v1#parte',
  ])('detecta query o fragmento en %s', (url) => {
    const problemas = problemasConfiguracionComptable(url, SECRETO);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(/query .* ni fragmento/);
  });

  it('acumula todos los problemas de una misma URL', () => {
    const problemas = problemasConfiguracionComptable(
      'https://u:p@comptable.ejemplo.com/api?x=1',
      SECRETO,
    );

    expect(problemas).toHaveLength(3);
  });

  it('nunca repite en los textos partes de la URL ni el secreto', () => {
    const urlMala =
      'https://marca-user:marca-clave@marca-host.ejemplo.com/x?q=1';

    const texto = [
      ...problemasConfiguracionComptable(urlMala, SECRETO),
      ...problemasConfiguracionComptable(urlMala, undefined),
      ...problemasConfiguracionComptable(undefined, SECRETO),
      ...problemasConfiguracionComptable('basura marca-clave', SECRETO),
    ].join('\n');

    for (const valor of ['marca-user', 'marca-clave', 'marca-host', SECRETO]) {
      expect(texto).not.toContain(valor);
    }
  });
});

describe('IntegracionComptableHealthIndicator', () => {
  it('con la integración deshabilitada (ni URL ni secreto) está up y lo dice como omitido', () => {
    expect(indicadorCon().check('integracion-comptable')).toEqual({
      'integracion-comptable': {
        status: 'up',
        omitido: MOTIVO_INTEGRACION_DESHABILITADA,
      },
    });
  });

  it('con URL y secreto coherentes está up, sin detalle', () => {
    expect(
      indicadorCon(URL_OK, SECRETO).check('integracion-comptable'),
    ).toEqual({ 'integracion-comptable': { status: 'up' } });
  });

  it('una URL sin /api/v1 deja el indicador down y nombra el ajuste a corregir', () => {
    const error = fallo(indicadorCon('https://comptable.ejemplo.com', SECRETO));

    expect(error.causes).toEqual({
      'integracion-comptable': {
        status: 'down',
        message: expect.stringMatching(
          /COMPTABLE_API_URL debe terminar en \/api\/v1/,
        ) as string,
      },
    });
  });

  it('la URL sin el secreto deja el indicador down', () => {
    const error = fallo(indicadorCon(URL_OK, undefined));

    expect(mensajeDe(error)).toMatch(/Falta COMPTABLE_HMAC_SECRET/);
  });

  it('el secreto sin la URL deja el indicador down', () => {
    const error = fallo(indicadorCon(undefined, SECRETO));

    expect(mensajeDe(error)).toMatch(/Falta COMPTABLE_API_URL/);
  });

  it('une varios problemas en un solo mensaje', () => {
    const error = fallo(
      indicadorCon('https://u:p@comptable.ejemplo.com/api', SECRETO),
    );

    const mensaje = mensajeDe(error);
    expect(mensaje).toContain('usuario ni contraseña');
    expect(mensaje).toContain('/api/v1');
    expect(mensaje).toContain('; ');
  });

  it('la respuesta pública nunca incluye el valor de la URL ni el del secreto', () => {
    const error = fallo(
      indicadorCon(
        'https://marca-user:marca-clave@marca-host.ejemplo.com/otra',
        SECRETO,
      ),
    );

    const publico = JSON.stringify(error.causes) + error.message;
    expect(publico).not.toContain('marca-host');
    expect(publico).not.toContain('marca-clave');
    expect(publico).not.toContain('marca-user');
    expect(publico).not.toContain(SECRETO);
  });

  it('no hace ninguna petición de red: lee solo la configuración', () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    try {
      indicadorCon(URL_OK, SECRETO).check('integracion-comptable');
      expect(() =>
        indicadorCon('https://comptable.ejemplo.com', SECRETO).check(
          'integracion-comptable',
        ),
      ).toThrow(HealthCheckError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
