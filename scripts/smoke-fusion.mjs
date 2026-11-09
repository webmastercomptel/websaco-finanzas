#!/usr/bin/env node
// scripts/smoke-fusion.mjs
//
// Read-only smoke test of a deployed (or local) backend after a rollout. Plain
// Node 22 (global fetch), no dependencies. It only sends GET and OPTIONS
// requests, never a body, and never prints the token.
//
//   node scripts/smoke-fusion.mjs --base-url https://<service>.run.app
//   node scripts/smoke-fusion.mjs --base-url http://localhost:3000 --token "$ID_TOKEN"
//
// Options (each also readable from the environment):
//   --base-url <url>   BASE_URL   Service address, with or without /api/v1.
//   --token <jwt>      ID_TOKEN   Firebase ID token of a real account. Optional:
//                                 without it the authenticated checks are skipped.
//   --origin <url>     ORIGIN     A frontend origin; adds a CORS preflight check.
//   --coproperty <id>  COPROPERTY_ID  Sent as X-CoProperty-Id on token checks.
//   --timeout <ms>     Per-request timeout (default 15000).
//
// Exit code: 0 when nothing failed (skipped checks do not fail), 1 otherwise.
// Run it against YOUR environment only: it is not meant for third-party hosts.

const PREFIJO_API = '/api/v1';

function leerArgumentos(argv, env) {
  const valores = {
    baseUrl: env.BASE_URL,
    token: env.ID_TOKEN,
    origin: env.ORIGIN,
    copropiedad: env.COPROPERTY_ID,
    timeout: env.SMOKE_TIMEOUT_MS,
  };
  const claves = {
    '--base-url': 'baseUrl',
    '--token': 'token',
    '--origin': 'origin',
    '--coproperty': 'copropiedad',
    '--timeout': 'timeout',
  };
  for (let i = 0; i < argv.length; i++) {
    const clave = claves[argv[i]];
    if (!clave) {
      throw new Error(`Argumento desconocido: ${argv[i]}`);
    }
    const valor = argv[++i];
    if (valor === undefined)
      throw new Error(`Falta el valor de ${argv[i - 1]}`);
    valores[clave] = valor;
  }
  if (!valores.baseUrl) {
    throw new Error('Falta BASE_URL (o --base-url).');
  }
  const base = valores.baseUrl.replace(/\/+$/, '');
  return {
    api: base.endsWith(PREFIJO_API) ? base : `${base}${PREFIJO_API}`,
    token: valores.token || undefined,
    origin: valores.origin || undefined,
    copropiedad: valores.copropiedad || undefined,
    timeout: Number(valores.timeout) > 0 ? Number(valores.timeout) : 15_000,
  };
}

async function pedir(config, ruta, { metodo = 'GET', cabeceras = {} } = {}) {
  try {
    const respuesta = await fetch(`${config.api}${ruta}`, {
      method: metodo,
      headers: cabeceras,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeout),
    });
    let cuerpo = null;
    try {
      cuerpo = await respuesta.json();
    } catch {
      /* not JSON (or empty): fine for these checks */
    }
    return { estado: respuesta.status, cabeceras: respuesta.headers, cuerpo };
  } catch (error) {
    return {
      error:
        error?.name === 'TimeoutError'
          ? 'timeout'
          : String(error?.cause?.code ?? error?.message ?? error),
    };
  }
}

/** A check: what we ask, and a predicate that explains what it saw. */
function construirChecks(config) {
  const conToken = {
    Authorization: `Bearer ${config.token}`,
    ...(config.copropiedad ? { 'X-CoProperty-Id': config.copropiedad } : {}),
  };
  const checks = [
    {
      nombre: 'Liveness /health/live',
      ruta: '/health/live',
      espera: '200',
      ok: (r) => r.estado === 200,
    },
    {
      nombre: 'Readiness /health/ready (Mongo, Redis, Comptable, correo)',
      ruta: '/health/ready',
      espera: '200 y status ok',
      ok: (r) => r.estado === 200 && r.cuerpo?.status === 'ok',
      detalle: (r) =>
        r.estado === 503
          ? 'revisar los indicadores en el cuerpo de la respuesta'
          : undefined,
    },
    {
      nombre: 'Conectividad /health (Mongo + Redis)',
      ruta: '/health',
      espera: '200',
      ok: (r) => r.estado === 200,
    },
    ...[
      ['/auth/me', 'Sesión'],
      ['/facturas', 'Facturas (Finanzas)'],
      ['/copropiedades', 'Copropiedades (plataforma)'],
      ['/portal/unidades', 'Portal del residente'],
      ['/pqrs', 'PQR (Administración)'],
      ['/documentos/carpetas', 'Documentos (Administración)'],
      ['/facturacion-bloque', 'Facturación por bloque'],
      ['/envio-facturas', 'Envío de facturas'],
    ].map(([ruta, nombre]) => ({
      nombre: `Sin token: ${nombre} ${ruta}`,
      ruta,
      espera: '401',
      ok: (r) => r.estado === 401,
    })),
    {
      nombre: 'Token inválido en /auth/me',
      ruta: '/auth/me',
      cabeceras: { Authorization: 'Bearer token-invalido' },
      espera: '401',
      ok: (r) => r.estado === 401,
    },
    {
      nombre: 'Ruta inexistente',
      ruta: '/ruta-que-no-existe',
      espera: '404',
      ok: (r) => r.estado === 404,
    },
  ];

  if (config.origin) {
    checks.push({
      nombre: `CORS: preflight desde ${config.origin}`,
      ruta: '/auth/me',
      metodo: 'OPTIONS',
      cabeceras: {
        Origin: config.origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-coproperty-id',
      },
      espera: '2xx, origen permitido y X-CoProperty-Id aceptado',
      ok: (r) =>
        r.estado >= 200 &&
        r.estado < 300 &&
        r.cabeceras.get('access-control-allow-origin') === config.origin &&
        /x-coproperty-id/i.test(
          r.cabeceras.get('access-control-allow-headers') ?? '',
        ),
    });
  }

  if (config.token) {
    checks.push(
      {
        nombre: 'Con token: /auth/me',
        ruta: '/auth/me',
        cabeceras: conToken,
        espera: '200 con envoltura { statusCode, data }',
        ok: (r) =>
          r.estado === 200 &&
          r.cuerpo?.statusCode === 200 &&
          r.cuerpo?.data != null,
        detalle: (r) =>
          r.estado === 401
            ? 'token vencido, o de otro proyecto de Firebase que el del backend'
            : undefined,
      },
      {
        nombre: 'Con token: /portal/unidades responde 200 o 403 (nunca 5xx)',
        ruta: '/portal/unidades',
        cabeceras: conToken,
        espera: '200 o 403',
        ok: (r) => r.estado === 200 || r.estado === 403,
      },
      {
        nombre: 'Con token: ruta de plataforma /copropiedades no responde 5xx',
        ruta: '/copropiedades',
        cabeceras: conToken,
        espera: '200 o 403',
        ok: (r) => r.estado === 200 || r.estado === 403,
      },
    );
  } else {
    checks.push({
      nombre: 'Comprobaciones con token',
      omitido: 'sin ID_TOKEN',
    });
  }
  return checks;
}

async function correr(config) {
  const filas = [];
  for (const check of construirChecks(config)) {
    if (check.omitido) {
      filas.push({
        nombre: check.nombre,
        espera: '-',
        visto: '-',
        resultado: 'SKIP',
        nota: check.omitido,
      });
      continue;
    }
    const r = await pedir(config, check.ruta, {
      metodo: check.metodo,
      cabeceras: check.cabeceras,
    });
    if (r.error) {
      filas.push({
        nombre: check.nombre,
        espera: check.espera,
        visto: `sin respuesta (${r.error})`,
        resultado: 'FAIL',
        nota: '',
      });
      continue;
    }
    filas.push({
      nombre: check.nombre,
      espera: check.espera,
      visto: String(r.estado),
      resultado: check.ok(r) ? 'PASS' : 'FAIL',
      nota: check.ok(r) ? '' : (check.detalle?.(r) ?? ''),
    });
  }
  return filas;
}

function imprimir(filas) {
  const columnas = [
    ['Resultado', 'resultado'],
    ['Comprobación', 'nombre'],
    ['Esperado', 'espera'],
    ['Visto', 'visto'],
    ['Nota', 'nota'],
  ];
  const ancho = columnas.map(([titulo, clave]) =>
    Math.max(titulo.length, ...filas.map((f) => String(f[clave]).length)),
  );
  const linea = (celdas) =>
    celdas
      .map((c, i) => String(c).padEnd(ancho[i]))
      .join('  ')
      .trimEnd();
  console.log(linea(columnas.map(([titulo]) => titulo)));
  console.log(ancho.map((a) => '-'.repeat(a)).join('  '));
  for (const fila of filas)
    console.log(linea(columnas.map(([, clave]) => fila[clave])));
}

async function main() {
  let config;
  try {
    config = leerArgumentos(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    console.error(
      'Uso: node scripts/smoke-fusion.mjs --base-url <url> [--token <jwt>] [--origin <url>] [--coproperty <id>]',
    );
    process.exit(2);
  }
  console.log(
    `Humo contra ${config.api} (${config.token ? 'con' : 'sin'} token)\n`,
  );
  const filas = await correr(config);
  imprimir(filas);
  const fallos = filas.filter((f) => f.resultado === 'FAIL').length;
  const pasaron = filas.filter((f) => f.resultado === 'PASS').length;
  const omitidos = filas.filter((f) => f.resultado === 'SKIP').length;
  console.log(
    `\n${pasaron} pasaron, ${fallos} fallaron, ${omitidos} omitidos.`,
  );
  process.exit(fallos > 0 ? 1 : 0);
}

await main();
