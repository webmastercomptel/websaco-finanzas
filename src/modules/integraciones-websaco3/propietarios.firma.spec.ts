import {
  PROPOSITO,
  VENTANA_SEGUNDOS,
  cadenaFirmaPropietarios,
  consultaCanonica,
  rutaYConsulta,
} from './propietarios.firma';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { VECTOR_COMPARTIDO } from './propietarios.vector';

describe('constantes', () => {
  it('el propósito y la ventana son los del contrato', () => {
    expect(PROPOSITO).toBe('propietarios.v1');
    expect(VENTANA_SEGUNDOS).toBe(300);
  });
});

describe('consultaCanonica', () => {
  it('devuelve cadena vacía sin query', () => {
    expect(consultaCanonica('')).toBe('');
  });

  it('no depende del orden en que llegan los pares', () => {
    expect(consultaCanonica('b=2&a=1')).toBe(consultaCanonica('a=1&b=2'));
    expect(consultaCanonica('b=2&a=1')).toBe('a=1&b=2');
  });

  it('ordena por clave y luego por valor (code units UTF-16)', () => {
    expect(consultaCanonica('a=b&a=a&A=z')).toBe('A=z&a=a&a=b');
  });

  it('re-codifica con encodeURIComponent y decodifica "+" como espacio', () => {
    expect(consultaCanonica('c=x+y&d=%C3%B1&e=a%2Fb')).toBe(
      'c=x%20y&d=%C3%B1&e=a%2Fb',
    );
  });

  it('normaliza escapes en minúscula y caracteres sin escapar', () => {
    expect(consultaCanonica('k=%c3%b1')).toBe(consultaCanonica('k=ñ'));
  });

  it('conserva las claves repetidas', () => {
    expect(consultaCanonica('id=2&id=1')).toBe('id=1&id=2');
  });

  it('conserva el valor tal cual (mayúsculas incluidas)', () => {
    expect(consultaCanonica('websaco3CopropiedadId=ABC')).toBe(
      'websaco3CopropiedadId=ABC',
    );
  });

  it('un parámetro sin valor se firma con valor vacío', () => {
    expect(consultaCanonica('flag')).toBe('flag=');
  });

  it('coincide con el vector compartido', () => {
    for (const caso of VECTOR_COMPARTIDO.casos) {
      expect(consultaCanonica(caso.rawQuery)).toBe(caso.sortedQuery);
    }
  });
});

describe('rutaYConsulta', () => {
  it('separa la ruta cruda de la query sin normalizar nada', () => {
    expect(rutaYConsulta('/api/v1/x/?a=1&b=2')).toEqual({
      path: '/api/v1/x/',
      rawQuery: 'a=1&b=2',
    });
  });

  it('sin "?" no hay query', () => {
    expect(rutaYConsulta('/api/v1/x')).toEqual({
      path: '/api/v1/x',
      rawQuery: '',
    });
  });

  it('solo corta en el primer "?"', () => {
    expect(rutaYConsulta('/p?a=1?b')).toEqual({
      path: '/p',
      rawQuery: 'a=1?b',
    });
  });

  it('descarta un fragmento si llegara', () => {
    expect(rutaYConsulta('/p?a=1#frag')).toEqual({
      path: '/p',
      rawQuery: 'a=1',
    });
  });
});

describe('cadenaFirmaPropietarios', () => {
  it('arma la cadena byte a byte con LF y sin salto final', () => {
    expect(
      cadenaFirmaPropietarios({
        timestamp: '1790000000',
        method: 'GET',
        path: '/api/v1/p',
        rawQuery: 'b=2&a=1',
      }),
    ).toBe('propietarios.v1\n1790000000\nGET\n/api/v1/p\na=1&b=2');
  });

  it('firma el método tal como llega (HEAD no reutiliza una firma GET)', () => {
    const base = { timestamp: '1', path: '/p', rawQuery: '' };

    expect(cadenaFirmaPropietarios({ ...base, method: 'HEAD' })).not.toBe(
      cadenaFirmaPropietarios({ ...base, method: 'GET' }),
    );
  });

  it('coincide byte a byte con el vector compartido y su firma', () => {
    for (const caso of VECTOR_COMPARTIDO.casos) {
      const cadena = cadenaFirmaPropietarios({
        timestamp: VECTOR_COMPARTIDO.timestamp,
        method: VECTOR_COMPARTIDO.method,
        path: VECTOR_COMPARTIDO.path,
        rawQuery: caso.rawQuery,
      });

      expect(cadena).toBe(caso.cadena);
      expect(`sha256=${hmacSha256Hex(VECTOR_COMPARTIDO.secret, cadena)}`).toBe(
        caso.firma,
      );
    }
  });
});
