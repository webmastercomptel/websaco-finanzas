import * as Sentry from '@sentry/node';
import type { Breadcrumb, Event } from '@sentry/node';

export interface OpcionesSentry {
  /** SENTRY_DSN; absent or empty = Sentry stays off. */
  dsn: string | undefined;
  /** NODE_ENV, reported as the Sentry environment. */
  env: string | undefined;
  /** Optional build/revision label (Cloud Run's K_REVISION). */
  release?: string;
}

const FILTRADO = '[Filtered]';

/**
 * The only request headers allowed to leave the process. An allow-list on
 * purpose: a deny-list misses the next custom credential header (HMAC
 * signatures, API keys, refresh tokens), an allow-list cannot.
 */
const HEADERS_PERMITIDOS = new Set([
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'accept',
  'accept-language',
  'accept-encoding',
  'origin',
  'x-coproperty-id',
  'x-request-id',
  'x-cloud-trace-context',
  'traceparent',
]);

/** Query/URL parameter names whose value is never sent. */
const CLAVE_SENSIBLE =
  /token|password|passwd|secret|signature|\bsig\b|auth|key|credential|session|jwt|bearer|cookie|code/i;

/** Breadcrumb `data` keys that carry bodies or headers of an HTTP exchange. */
const DATOS_HTTP_PROHIBIDOS = [
  'request_body',
  'response_body',
  'request_headers',
  'response_headers',
  'headers',
  'body',
  'data',
];

/** Span/breadcrumb data keys that hold a URL or a query string. */
const CLAVES_URL = [
  'url',
  'http.url',
  'url.full',
  'http.target',
  'http.query',
  'url.query',
];

/** Redacts the value of every sensitive `name=value` pair of a query string. */
function limpiarQueryTexto(query: string): string {
  return query
    .split('&')
    .map((par) => {
      const igual = par.indexOf('=');
      if (igual < 0) return par;
      let clave = par.slice(0, igual);
      try {
        clave = decodeURIComponent(clave);
      } catch {
        // Malformed escape: judge the raw text.
      }
      return CLAVE_SENSIBLE.test(clave)
        ? `${par.slice(0, igual)}=${FILTRADO}`
        : par;
    })
    .join('&');
}

/** Same as above for a query already parsed into an object. */
function limpiarQueryObjeto(
  query: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).map(([clave, valor]) => [
      clave,
      CLAVE_SENSIBLE.test(clave) ? FILTRADO : valor,
    ]),
  );
}

/** Cleans the query part of a URL (and drops its fragment). */
function limpiarUrl(url: string): string {
  const almohadilla = url.indexOf('#');
  const sinFragmento = almohadilla < 0 ? url : url.slice(0, almohadilla);
  const interrogacion = sinFragmento.indexOf('?');
  if (interrogacion < 0) return sinFragmento;
  return `${sinFragmento.slice(0, interrogacion + 1)}${limpiarQueryTexto(
    sinFragmento.slice(interrogacion + 1),
  )}`;
}

/** A value that is either a URL or a bare query string (`http.query`). */
function limpiarTextoUrl(valor: string): string {
  return valor.includes('?') || valor.includes('/')
    ? limpiarUrl(valor)
    : limpiarQueryTexto(valor.replace(/^\?/, ''));
}

function limpiarDatosConUrl(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const salida = { ...data };
  for (const clave of CLAVES_URL) {
    const valor = salida[clave];
    if (typeof valor === 'string') salida[clave] = limpiarTextoUrl(valor);
  }
  return salida;
}

/**
 * A breadcrumb of an HTTP exchange keeps its method, status and a cleaned URL;
 * bodies and headers never leave (outgoing calls such as the Firebase token
 * lookup carry credentials in them).
 */
export function limpiarBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (!crumb.data) return crumb;
  const data = limpiarDatosConUrl(crumb.data);
  if (['http', 'fetch', 'xhr'].includes(crumb.category ?? '')) {
    for (const clave of DATOS_HTTP_PROHIBIDOS) delete data[clave];
  }
  return { ...crumb, data };
}

/**
 * Strips from an event everything that can carry a credential or resident
 * data: request body and cookies, every header outside the allow-list, the
 * sensitive query values (in the URL and in `query_string`), the client
 * address and any user field but the id, plus the HTTP breadcrumbs and span
 * URLs. Method, path and the allowed headers stay, so a failure is still
 * traceable. Works on errors and on transactions alike.
 */
export function limpiarEvento<T extends Event>(evento: T): T {
  if (evento.request) {
    const peticion = { ...evento.request };
    delete peticion.data;
    delete peticion.cookies;
    delete peticion.env;
    if (peticion.headers) {
      peticion.headers = Object.fromEntries(
        Object.entries(peticion.headers).filter(([nombre]) =>
          HEADERS_PERMITIDOS.has(nombre.toLowerCase()),
        ),
      );
    }
    if (typeof peticion.url === 'string') {
      peticion.url = limpiarUrl(peticion.url);
    }
    const query = peticion.query_string as unknown;
    if (typeof query === 'string') {
      peticion.query_string = limpiarQueryTexto(query.replace(/^\?/, ''));
    } else if (Array.isArray(query)) {
      peticion.query_string = query.map(([clave, valor]: [string, string]) => [
        clave,
        CLAVE_SENSIBLE.test(clave) ? FILTRADO : valor,
      ]) as never;
    } else if (query && typeof query === 'object') {
      peticion.query_string = limpiarQueryObjeto(
        query as Record<string, unknown>,
      ) as never;
    }
    evento.request = peticion;
  }
  if (evento.user) {
    evento.user = evento.user.id === undefined ? {} : { id: evento.user.id };
  }
  if (evento.breadcrumbs) {
    evento.breadcrumbs = evento.breadcrumbs.map(limpiarBreadcrumb);
  }
  const trazaDatos = evento.contexts?.trace?.data;
  if (trazaDatos && evento.contexts?.trace) {
    evento.contexts.trace.data = limpiarDatosConUrl(trazaDatos);
  }
  if ('spans' in evento && evento.spans) {
    evento.spans = evento.spans.map((span) =>
      span.data ? { ...span, data: limpiarDatosConUrl(span.data) } : span,
    ) as never;
  }
  return evento;
}

/**
 * Starts error reporting when a DSN is configured; returns whether it did.
 * Must run before the app is created. Deliberately minimal: no tracing, no
 * default PII, and three layers so that request bodies and credentials (they
 * carry invoice data, resident data and the Firebase ID token) never reach
 * Sentry: (1) the HTTP integration is told not to capture incoming bodies at
 * all (`sendDefaultPii: false` does not turn that off); (2) `beforeSend` /
 * `beforeSendTransaction` strip whatever is left on the event (see
 * `limpiarEvento`: body, cookies, non-allow-listed headers, sensitive query
 * values, user fields); (3) `beforeBreadcrumb` cleans HTTP breadcrumbs. What
 * does reach Sentry: the stack, the exception, the HTTP method, the path and
 * a few harmless headers. Without a DSN nothing is initialised and
 * `captureException` is a no-op.
 */
export function iniciarSentry({ dsn, env, release }: OpcionesSentry): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: env,
    release,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: (porDefecto) => [
      ...porDefecto.filter((integracion) => integracion.name !== 'Http'),
      Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' }),
    ],
    beforeSend: (evento) => limpiarEvento(evento),
    beforeSendTransaction: (evento) => limpiarEvento(evento),
    beforeBreadcrumb: (crumb) => limpiarBreadcrumb(crumb),
  });
  return true;
}
