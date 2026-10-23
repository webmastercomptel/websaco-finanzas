import { resolve } from 'node:path';
import {
  confirmTarget,
  describeMongoTarget,
  loadEnvFile,
  needsConfirmation,
  parseDatabaseOverride,
  parseEnvName,
  ScriptEnvError,
} from './script-env';

describe('parseEnvName', () => {
  it('toma el nombre de --env=<nombre> e ignora los demás argumentos', () => {
    expect(parseEnvName(['--simular', '--env=local', '--otra'])).toBe('local');
    expect(parseEnvName(['--env=staging-2'])).toBe('staging-2');
  });

  it('falla con el uso cuando falta --env, sin caer en el .env común', () => {
    expect(() => parseEnvName([])).toThrow(ScriptEnvError);
    expect(() => parseEnvName(['--simular'])).toThrow(
      /npm run <script> -- --env=<ambiente>/,
    );
  });

  it('explica que el "--" de npm es obligatorio', () => {
    expect(() => parseEnvName([])).toThrow(/El "--" antes de --env/);
  });

  it('rechaza --env sin "=" y --env vacío', () => {
    expect(() => parseEnvName(['--env', 'local'])).toThrow(/--env=<ambiente>/);
    expect(() => parseEnvName(['--env='])).toThrow(/inválido/);
  });

  it('rechaza el flag repetido', () => {
    expect(() => parseEnvName(['--env=local', '--env=production'])).toThrow(
      /más de una vez/,
    );
  });

  it.each(['../x', 'a/b', 'a\\b', 'prod.bak', 'Prod', 'prod uction', 'ñ', '.'])(
    'rechaza el nombre inválido %p (sin recorrido de rutas)',
    (nombre) => {
      expect(() => parseEnvName([`--env=${nombre}`])).toThrow(
        /Nombre de ambiente inválido/,
      );
    },
  );
});

describe('needsConfirmation', () => {
  it.each(['local', 'dev', 'development', 'test'])(
    'no pide confirmación para el ambiente no productivo %p',
    (nombre) => {
      expect(needsConfirmation(nombre)).toBe(false);
    },
  );

  it.each(['production', 'prod', 'produccion', 'prd', 'staging', 'qa', 'x'])(
    'pide confirmación para %p: todo lo que no está en la lista permitida',
    (nombre) => {
      expect(needsConfirmation(nombre)).toBe(true);
    },
  );
});

describe('parseDatabaseOverride', () => {
  it('toma el valor de --db=<nombre> e ignora los demás argumentos', () => {
    expect(
      parseDatabaseOverride(['--env=production', '--db=finanzas', '--aplicar']),
    ).toBe('finanzas');
  });

  it('devuelve undefined cuando no hay --db o viene vacío', () => {
    expect(parseDatabaseOverride(['--env=local', '--simular'])).toBeUndefined();
    expect(parseDatabaseOverride(['--db='])).toBeUndefined();
  });
});

describe('describeMongoTarget', () => {
  it('con --db la base indicada reemplaza a la de la URI en la base y en el destino enmascarado', () => {
    const destino = describeMongoTarget(
      'mongodb+srv://admin:s3cr3t@cluster0.abc.mongodb.net/otra?retryWrites=true',
      'production',
    );

    expect(destino.database).toBe('production');
    expect(destino.masked).toBe(
      'mongodb+srv://***@cluster0.abc.mongodb.net/production',
    );
  });

  it('con --db y una URI sin base, la base es la indicada y no "test"', () => {
    expect(
      describeMongoTarget('mongodb://u:p@h1:27017', 'production').database,
    ).toBe('production');
  });

  it('devuelve host y base de datos de una URI SRV, sin credenciales', () => {
    const uri =
      'mongodb+srv://admin:s3cr3t@cluster0.abc.mongodb.net/finanzas?retryWrites=true&w=majority';

    const destino = describeMongoTarget(uri);

    expect(destino.host).toBe('cluster0.abc.mongodb.net');
    expect(destino.database).toBe('finanzas');
    expect(destino.masked).toBe(
      'mongodb+srv://***@cluster0.abc.mongodb.net/finanzas',
    );
    expect(JSON.stringify(destino)).not.toContain('admin');
    expect(JSON.stringify(destino)).not.toContain('s3cr3t');
  });

  it('soporta la forma legacy con varios hosts', () => {
    const destino = describeMongoTarget(
      'mongodb://u:p@h1.example.com:27017,h2.example.com:27017/miDb?replicaSet=rs0',
    );

    expect(destino.host).toBe('h1.example.com:27017,h2.example.com:27017');
    expect(destino.database).toBe('miDb');
  });

  it.each([
    ['con @ sin codificar', 'mongodb+srv://usr:pa@ss@host.example.com/db'],
    ['codificada', 'mongodb+srv://usr:pa%40ss%2Fxx@host.example.com/db'],
  ])('la contraseña %s nunca aparece en el destino', (_caso, uri) => {
    const destino = describeMongoTarget(uri);

    const salida = JSON.stringify(destino);
    expect(destino.host).toBe('host.example.com');
    expect(destino.database).toBe('db');
    for (const secreto of ['usr', 'pa@ss', 'pa%40ss', 'xx']) {
      expect(salida).not.toContain(secreto);
    }
  });

  it.each([
    [
      'appName con @ en la query (SRV)',
      'mongodb+srv://u:p@cluster0.x.mongodb.net/finanzas?appName=ops@laptop',
      'cluster0.x.mongodb.net',
      'finanzas',
      'mongodb+srv://***@cluster0.x.mongodb.net/finanzas',
    ],
    [
      'sin credenciales y con @ en la query',
      'mongodb://h/db?x=a@b',
      'h',
      'db',
      'mongodb://h/db',
    ],
    [
      'con credenciales y @ en la query de varios hosts',
      'mongodb://usr:secreto@h1:27017,h2:27017/miDb?replicaSet=rs0&appName=a@b',
      'h1:27017,h2:27017',
      'miDb',
      'mongodb://***@h1:27017,h2:27017/miDb',
    ],
  ])(
    'un @ dentro de la query no engaña al parseo: %s',
    (_caso, uri, host, database, masked) => {
      const destino = describeMongoTarget(uri);

      expect(destino).toEqual({ host, database, masked });
      for (const secreto of ['usr', 'secreto', 'laptop', 'a@b']) {
        expect(JSON.stringify(destino)).not.toContain(secreto);
      }
    },
  );

  it.each([
    ['con / sin codificar', 'mongodb+srv://usr:pa/ss@host.example.com/db'],
    ['con ? sin codificar', 'mongodb+srv://usr:pa?ss@host.example.com/db'],
  ])(
    'falla cerrado, sin imprimir la contraseña, cuando está %s',
    (_caso, uri) => {
      expect.assertions(3);
      try {
        describeMongoTarget(uri);
      } catch (e) {
        expect(e).toBeInstanceOf(ScriptEnvError);
        expect((e as Error).message).toMatch(/formato inesperado/);
        expect((e as Error).message).not.toMatch(/usr|pa[/?:]ss/);
      }
    },
  );

  it('acepta una URI sin credenciales', () => {
    expect(
      describeMongoTarget('mongodb://localhost:27017/local-db').masked,
    ).toBe('mongodb://localhost:27017/local-db');
  });

  it('usa "test" (el valor por defecto del driver) cuando la URI no trae base', () => {
    expect(describeMongoTarget('mongodb://u:p@host.example.com').database).toBe(
      'test',
    );
    expect(
      describeMongoTarget('mongodb://u:p@host.example.com/?x=1').database,
    ).toBe('test');
  });

  it('falla con mensaje claro si no hay URI o el esquema es otro', () => {
    expect(() => describeMongoTarget(undefined)).toThrow(/no está definida/);
    expect(() => describeMongoTarget('http://host/db')).toThrow(
      /mongodb:\/\/ o mongodb\+srv:\/\//,
    );
  });

  it('no repite la entrada en el error cuando el host no se puede interpretar', () => {
    expect.assertions(2);
    try {
      describeMongoTarget('mongodb://u:topsecret@ho st/db');
    } catch (e) {
      expect((e as Error).message).toMatch(/formato inesperado/);
      expect((e as Error).message).not.toContain('topsecret');
    }
  });
});

describe('loadEnvFile', () => {
  const directorio = resolve('/proyecto/backend');
  const rutaProd = resolve(directorio, '.env.production');
  const rutaComun = resolve(directorio, '.env');
  // The plain .env is never read; the constant is only the bait of a test.

  /** Fake disk: path → content. */
  const disco = (archivos: Record<string, string>) => ({
    exists: (ruta: string) => ruta in archivos,
    read: (ruta: string) => archivos[ruta],
  });

  it('carga .env.<nombre> y pisa un valor que ya estaba en el entorno', () => {
    const env: NodeJS.ProcessEnv = {
      MONGODB_URI: 'mongodb://viejo/db-vieja',
      OTRA: 'intacta',
    };

    const resultado = loadEnvFile({
      name: 'production',
      directory: directorio,
      env,
      ...disco({
        [rutaProd]:
          'MONGODB_URI=mongodb://nuevo/db-nueva\nREDIS_URL=redis://r\n',
      }),
    });

    expect(env.MONGODB_URI).toBe('mongodb://nuevo/db-nueva');
    expect(env.REDIS_URL).toBe('redis://r');
    expect(env.OTRA).toBe('intacta');
    expect(resultado.path).toBe(rutaProd);
    expect(resultado.overridden).toEqual(['MONGODB_URI']);
  });

  it('no reporta como reemplazada una variable con el mismo valor', () => {
    const env: NodeJS.ProcessEnv = { MONGODB_URI: 'mongodb://igual/db' };

    const resultado = loadEnvFile({
      name: 'production',
      directory: directorio,
      env,
      ...disco({ [rutaProd]: 'MONGODB_URI=mongodb://igual/db\n' }),
    });

    expect(resultado.overridden).toEqual([]);
  });

  it('no lee nunca el .env común: el archivo del ambiente es la única fuente', () => {
    const leidos: string[] = [];
    const archivos: Record<string, string> = {
      [rutaProd]: 'MONGODB_URI=mongodb://p/db\n',
      [rutaComun]: 'MONGODB_URI=mongodb://d/db\nREDIS_URL=redis://dev\n',
    };
    const env: NodeJS.ProcessEnv = {};

    loadEnvFile({
      name: 'production',
      directory: directorio,
      env,
      exists: (ruta) => ruta in archivos,
      read: (ruta) => {
        leidos.push(ruta);
        return archivos[ruta];
      },
    });

    expect(leidos).toEqual([rutaProd]);
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('avisa qué variables de la app el archivo no define', () => {
    const resultado = loadEnvFile({
      name: 'production',
      directory: directorio,
      env: {},
      knownKeys: ['MONGODB_URI', 'REDIS_URL', 'ROOT_ADMIN_EMAIL'],
      ...disco({ [rutaProd]: 'MONGODB_URI=mongodb://p/db\n' }),
    });

    expect(resultado.omitted).toEqual(['REDIS_URL', 'ROOT_ADMIN_EMAIL']);
    expect(resultado.discardedFromShell).toEqual([]);
  });

  it('descarta y reporta la variable de la app que la terminal exportó y el archivo omite', () => {
    const env: NodeJS.ProcessEnv = {
      ROOT_ADMIN_EMAIL: 'viejo@ejemplo.com',
      PATH: '/usr/bin',
    };

    const resultado = loadEnvFile({
      name: 'production',
      directory: directorio,
      env,
      knownKeys: ['MONGODB_URI', 'ROOT_ADMIN_EMAIL'],
      ...disco({ [rutaProd]: 'MONGODB_URI=mongodb://p/db\n' }),
    });

    expect(env.ROOT_ADMIN_EMAIL).toBeUndefined();
    expect(resultado.discardedFromShell).toEqual(['ROOT_ADMIN_EMAIL']);
    // Unrelated shell variables are never touched.
    expect(env.PATH).toBe('/usr/bin');
  });

  it('falla nombrando la ruta esperada cuando el archivo no existe', () => {
    expect(() =>
      loadEnvFile({
        name: 'staging',
        directory: directorio,
        env: {},
        ...disco({}),
      }),
    ).toThrow(
      new ScriptEnvError(
        `No existe el archivo del ambiente "staging". Se esperaba: ${resolve(directorio, '.env.staging')}`,
      ),
    );
  });

  it('falla si el archivo no define MONGODB_URI, aunque el entorno la tenga', () => {
    expect(() =>
      loadEnvFile({
        name: 'production',
        directory: directorio,
        env: { MONGODB_URI: 'mongodb://del-shell/db' },
        ...disco({ [rutaProd]: 'REDIS_URL=redis://r\n' }),
      }),
    ).toThrow(/no define MONGODB_URI/);
  });
});

describe('confirmTarget', () => {
  const env: NodeJS.ProcessEnv = {
    MONGODB_URI: 'mongodb+srv://admin:s3cr3t@cluster0.abc.mongodb.net/finanzas',
  };

  function armar(respuesta: string) {
    const lineas: string[] = [];
    const ask = jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValue(respuesta);
    return { lineas, ask, print: (l: string) => lineas.push(l) };
  }

  it('en un ambiente no productivo imprime el destino y no pregunta nada', async () => {
    const { lineas, ask, print } = armar('');

    await confirmTarget({
      envName: 'local',
      env,
      ask,
      print,
      isInteractive: true,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(lineas.join('\n')).toContain('finanzas');
    expect(lineas.join('\n')).toContain('cluster0.abc.mongodb.net');
  });

  it('nunca imprime las credenciales, ni en el destino ni en la pregunta', async () => {
    const { lineas, ask, print } = armar('finanzas');

    await confirmTarget({
      envName: 'production',
      env,
      ask,
      print,
      isInteractive: true,
    });

    const todo = [...lineas, ...ask.mock.calls.map((c) => String(c[0]))].join(
      '\n',
    );
    expect(todo).not.toContain('admin');
    expect(todo).not.toContain('s3cr3t');
  });

  it('en producción continúa cuando se escribe el nombre de la base de datos', async () => {
    const { ask, print } = armar('  finanzas \n');

    await expect(
      confirmTarget({
        envName: 'production',
        env,
        ask,
        print,
        isInteractive: true,
      }),
    ).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'y', 'si', 'Finanzas', 'otra-base'])(
    'en producción aborta si la respuesta es %p',
    async (respuesta) => {
      const { ask, print } = armar(respuesta);

      await expect(
        confirmTarget({
          envName: 'production',
          env,
          ask,
          print,
          isInteractive: true,
        }),
      ).rejects.toThrow(/La confirmación no coincide/);
    },
  );

  it('con --db pide escribir la base que se va a tocar, no la de la URI', async () => {
    const aceptada = armar('production');
    await expect(
      confirmTarget({
        envName: 'production',
        env,
        ask: aceptada.ask,
        print: aceptada.print,
        isInteractive: true,
        databaseOverride: 'production',
      }),
    ).resolves.toBeUndefined();
    expect(aceptada.lineas.join('\n')).toContain('/production');

    const rechazada = armar('finanzas');
    await expect(
      confirmTarget({
        envName: 'production',
        env,
        ask: rechazada.ask,
        print: rechazada.print,
        isInteractive: true,
        databaseOverride: 'production',
      }),
    ).rejects.toThrow(/La confirmación no coincide/);
  });

  it('exige una terminal interactiva: una respuesta por pipe no sirve de confirmación', async () => {
    const { ask, print } = armar('finanzas');

    await expect(
      confirmTarget({
        envName: 'production',
        env,
        ask,
        print,
        isInteractive: false,
      }),
    ).rejects.toThrow(/no es interactiva/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('en un ambiente no productivo no necesita terminal interactiva', async () => {
    const { ask, print } = armar('');

    await expect(
      confirmTarget({ envName: 'test', env, ask, print, isInteractive: false }),
    ).resolves.toBeUndefined();
  });

  it('un nombre fuera de la lista permitida (ej. staging) también exige confirmación', async () => {
    const { ask, print } = armar('nope');

    await expect(
      confirmTarget({
        envName: 'staging',
        env,
        ask,
        print,
        isInteractive: true,
      }),
    ).rejects.toThrow(ScriptEnvError);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
