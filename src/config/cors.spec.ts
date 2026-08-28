import { corsOptionsFor } from './cors';

type OriginFn = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void;

/** Asks the policy whether it would accept `origin`. */
const permite = (
  env: string | undefined,
  raw: string | undefined,
  origin: string | undefined,
): boolean => {
  const originFn = corsOptionsFor(env, raw).origin as OriginFn;
  let allowed = false;
  originFn(origin, (err, allow) => {
    expect(err).toBeNull();
    allowed = allow === true;
  });
  return allowed;
};

describe('corsOptionsFor', () => {
  describe('en desarrollo', () => {
    it('acepta cualquier puerto de localhost', () => {
      // Vite se corre de puerto cuando el default está ocupado. Una política
      // que se rompe en 5174 termina "arreglada" abriéndola a todo.
      for (const puerto of [5173, 5174, 4173, 3001]) {
        expect(permite('development', '', `http://localhost:${puerto}`)).toBe(
          true,
        );
      }
    });

    it('acepta 127.0.0.1 igual que localhost', () => {
      expect(permite('development', '', 'http://127.0.0.1:5173')).toBe(true);
    });

    it('NO acepta un origen externo aunque sea desarrollo', () => {
      // La relajación es solo para loopback, que es la máquina de quien
      // desarrolla — no una puerta abierta.
      expect(permite('development', '', 'https://sitio-ajeno.com')).toBe(false);
    });

    it('no se deja engañar por un host que contiene "localhost"', () => {
      expect(permite('development', '', 'https://localhost.atacante.com')).toBe(
        false,
      );
    });
  });

  describe('en producción', () => {
    const lista = 'https://finanzas.ejemplo.com';

    it('acepta un origen de la lista', () => {
      expect(permite('production', lista, 'https://finanzas.ejemplo.com')).toBe(
        true,
      );
    });

    it('NO acepta localhost', () => {
      expect(permite('production', lista, 'http://localhost:5173')).toBe(false);
    });

    it('NO acepta un origen fuera de la lista', () => {
      expect(permite('production', lista, 'https://otro.ejemplo.com')).toBe(
        false,
      );
    });

    it('acepta varios orígenes separados por coma', () => {
      const varios = 'https://a.ejemplo.com, https://b.ejemplo.com';

      expect(permite('production', varios, 'https://a.ejemplo.com')).toBe(true);
      expect(permite('production', varios, 'https://b.ejemplo.com')).toBe(true);
      expect(permite('production', varios, 'https://c.ejemplo.com')).toBe(
        false,
      );
    });

    it('tolera una barra final en la configuración y en el pedido', () => {
      // Copiar la URL del navegador trae la barra; que eso rompa CORS es una
      // hora perdida por un carácter.
      expect(
        permite(
          'production',
          'https://finanzas.ejemplo.com/',
          'https://finanzas.ejemplo.com',
        ),
      ).toBe(true);
      expect(
        permite(
          'production',
          'https://finanzas.ejemplo.com',
          'https://finanzas.ejemplo.com/',
        ),
      ).toBe(true);
    });
  });

  it('permite peticiones sin cabecera Origin', () => {
    // curl, un health probe, o same-origin: no hay nada que decidir.
    expect(
      permite('production', 'https://finanzas.ejemplo.com', undefined),
    ).toBe(true);
  });

  it('deniega respondiendo, nunca lanzando un error', () => {
    // Lanzar acá se convierte en un 500 y esconde una decisión de política
    // detrás de lo que parece una falla del servidor.
    const originFn = corsOptionsFor('production', '') as unknown as {
      origin: OriginFn;
    };
    expect(() =>
      originFn.origin('https://sitio-ajeno.com', () => undefined),
    ).not.toThrow();
  });

  it('deja pasar las cabeceras que el cliente necesita mandar', () => {
    const { allowedHeaders } = corsOptionsFor('development', '');

    expect(allowedHeaders).toContain('Authorization');
    expect(allowedHeaders).toContain('X-CoProperty-Id');
  });

  it('no habilita credenciales', () => {
    // credentials:true junto con el permiso amplio de localhost sería el
    // agujero clásico de CORS. La sesión viaja en Authorization, no en cookies.
    expect(corsOptionsFor('development', '').credentials).toBe(false);
  });
});
