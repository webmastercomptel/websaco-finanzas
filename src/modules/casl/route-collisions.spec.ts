// src/modules/casl/route-collisions.spec.ts
//
// Route-collision guard: two handlers that can answer the SAME request make the
// outcome depend on module registration order, and the loser is unreachable.
// Born from two controllers both declaring `@Controller('documentos')` (Finanzas'
// document-type table and Administración's building library): `GET /documentos`
// answered with whichever registered first, in the wrong shape, and the
// frontend crashed. Same mechanism as `route-policies.spec.ts`: the metadata
// Nest itself reads at runtime.
import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

// Controllers are only imported to read decorator metadata, never executed. The
// PDF renderer does not resolve in every environment, so it is stubbed (same
// reason as in route-policies.spec.ts).
const mockPdfStub: unknown = new Proxy(function stub() {}, {
  get: (_target, prop) => (prop === '__esModule' ? true : mockPdfStub),
  apply: () => mockPdfStub,
});
jest.mock('@react-pdf/renderer', () => mockPdfStub);

type Ctor = new (...args: never[]) => object;
type Handler = (...args: never[]) => unknown;

/** One declared route, with its full path (no global prefix) split in segments. */
export interface RutaDeclarada {
  /** `Controller.method`, for the failure message. */
  origen: string;
  /**
   * Controller identity (the class itself, NOT its name: both colliding
   * controllers were called `DocumentosController`). Ordering inside one
   * controller is the author's call.
   */
  controlador: unknown;
  metodo: RequestMethod;
  segmentos: string[];
}

/** `:id`, `:documentType`… all become `:p`: the name never changes what matches. */
function normalizarSegmento(segmento: string): string {
  return segmento.startsWith(':') ? ':p' : segmento;
}

function segmentosDe(...partes: string[]): string[] {
  return partes
    .join('/')
    .split('/')
    .filter((s) => s.length > 0)
    .map(normalizarSegmento);
}

/** A `@Get()` has path `/`, an array decorator yields several paths. */
function comoLista(valor: unknown): string[] {
  if (Array.isArray(valor)) return valor as string[];
  return [typeof valor === 'string' ? valor : ''];
}

function rutaTexto(r: RutaDeclarada): string {
  return `${RequestMethod[r.metodo]} /${r.segmentos.join('/')}`;
}

function mismoMetodo(a: RequestMethod, b: RequestMethod): boolean {
  return a === b || a === RequestMethod.ALL || b === RequestMethod.ALL;
}

/**
 * True when some request can match both patterns: same length and, segment by
 * segment, equal literals or a `:param` on either side (`/x/:p` swallows
 * `/x/stats`). A wildcard segment (`*`) is treated like a param.
 */
function sePisan(a: RutaDeclarada, b: RutaDeclarada): boolean {
  if (!mismoMetodo(a.metodo, b.metodo)) return false;
  if (a.segmentos.length !== b.segmentos.length) return false;
  return a.segmentos.every((s, i) => {
    const o = b.segmentos[i];
    return s === o || s === ':p' || o === ':p' || s === '*' || o === '*';
  });
}

/**
 * Returns a description of every pair of routes that can resolve the same
 * request. Inside ONE controller only a truly identical (verb + path) pair is a
 * problem — the declaration order of `:id` versus a static segment is handled
 * by the author and by Nest's order of registration within the class. Across
 * controllers any overlap is a problem: module order is not a design tool.
 */
export function colisiones(rutas: RutaDeclarada[]): string[] {
  const problemas: string[] = [];
  for (let i = 0; i < rutas.length; i += 1) {
    for (let j = i + 1; j < rutas.length; j += 1) {
      const a = rutas[i];
      const b = rutas[j];
      const mismoControlador = a.controlador === b.controlador;
      const identicas =
        a.metodo === b.metodo &&
        a.segmentos.length === b.segmentos.length &&
        a.segmentos.every((s, k) => s === b.segmentos[k]);
      const choque = mismoControlador ? identicas : sePisan(a, b);
      if (choque) {
        problemas.push(
          `${rutaTexto(a)} (${a.origen}) pisa a ${rutaTexto(b)} (${b.origen})`,
        );
      }
    }
  }
  return problemas;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.controller.ts'))
    .map((e) => join(e.parentPath, e.name));
}

function rutasDe(controller: Ctor): RutaDeclarada[] {
  const prefijos = comoLista(Reflect.getMetadata(PATH_METADATA, controller));
  const rutas: RutaDeclarada[] = [];
  for (const nombre of Object.getOwnPropertyNames(controller.prototype)) {
    if (nombre === 'constructor') continue;
    const fn = (controller.prototype as Record<string, Handler>)[nombre];
    if (typeof fn !== 'function') continue;
    const metodo = Reflect.getMetadata(METHOD_METADATA, fn) as
      RequestMethod | undefined;
    const rutaMetodo: unknown = Reflect.getMetadata(PATH_METADATA, fn);
    if (metodo === undefined || rutaMetodo === undefined) continue;
    for (const prefijo of prefijos) {
      for (const ruta of comoLista(rutaMetodo)) {
        rutas.push({
          origen: `${controller.name}.${nombre}`,
          controlador: controller,
          metodo,
          segmentos: segmentosDe(prefijo, ruta),
        });
      }
    }
  }
  return rutas;
}

function ruta(
  controlador: string,
  metodo: RequestMethod,
  ...segmentos: string[]
): RutaDeclarada {
  return {
    origen: `${controlador}.x`,
    controlador,
    metodo,
    segmentos: segmentosDe(...segmentos),
  };
}

describe('colisiones (clasificador)', () => {
  const GET = RequestMethod.GET;
  const POST = RequestMethod.POST;

  it('detecta la misma ruta y verbo en dos controladores', () => {
    expect(
      colisiones([ruta('A', GET, 'documentos'), ruta('B', GET, 'documentos')]),
    ).toHaveLength(1);
  });

  it('un verbo distinto no choca', () => {
    expect(
      colisiones([ruta('A', GET, 'documentos'), ruta('B', POST, 'documentos')]),
    ).toEqual([]);
  });

  it('detecta un parámetro que se traga una ruta estática de OTRO controlador', () => {
    expect(
      colisiones([ruta('A', GET, 'x', ':id'), ruta('B', GET, 'x', 'stats')]),
    ).toHaveLength(1);
  });

  it('dentro de un mismo controlador, :id frente a una ruta estática NO es error', () => {
    expect(
      colisiones([ruta('A', GET, 'x', 'stats'), ruta('A', GET, 'x', ':id')]),
    ).toEqual([]);
  });

  it('dentro de un mismo controlador, dos rutas idénticas sí lo son (el nombre del parámetro no cuenta)', () => {
    expect(
      colisiones([ruta('A', GET, 'x', ':id'), ruta('A', GET, 'x', ':otro')]),
    ).toHaveLength(1);
  });

  it('longitudes distintas no chocan', () => {
    expect(
      colisiones([ruta('A', GET, 'x'), ruta('B', GET, 'x', ':id')]),
    ).toEqual([]);
  });

  it('prefijos distintos no chocan (portal/documentos vs documentos-administracion)', () => {
    expect(
      colisiones([
        ruta('A', GET, 'portal/documentos', ':id'),
        ruta('B', GET, 'documentos-administracion', ':id'),
      ]),
    ).toEqual([]);
  });
});

describe('inventario de colisiones de rutas', () => {
  const srcRoot = join(__dirname, '..', '..');
  const files = controllerFiles(srcRoot);

  it('ningún par de handlers puede resolver la misma petición', () => {
    const vistos = new Set<unknown>();
    const rutas: RutaDeclarada[] = [];
    const unloadable: string[] = [];

    for (const file of files) {
      let mod: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require(file) as Record<string, unknown>;
      } catch (e) {
        unloadable.push(`${relative(srcRoot, file)}: ${(e as Error).message}`);
        continue;
      }
      for (const exported of Object.values(mod)) {
        if (typeof exported !== 'function' || vistos.has(exported)) continue;
        if (Reflect.getMetadata(PATH_METADATA, exported) === undefined) {
          continue;
        }
        vistos.add(exported);
        rutas.push(...rutasDe(exported as unknown as Ctor));
      }
    }

    expect(unloadable).toEqual([]);
    expect(rutas.length).toBeGreaterThan(100);
    expect(colisiones(rutas)).toEqual([]);
  });
});
