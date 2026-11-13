// src/modules/casl/route-policies.spec.ts
//
// Route-policy inventory: every HTTP route in the backend must declare HOW it is
// protected, so a new route can never ship open by omission. It reads the same
// metadata Nest reads at runtime (guards, path/method, ability decorators), so a
// green run means the decorators on disk are what the framework will enforce.
import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  AUTHENTICATED_ONLY_KEY,
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
  PUBLIC_KEY,
} from './check-ability.decorator';
import { MODULOS_PRODUCTO } from '../../common/licencia/modulos';

// Controllers are only imported to read decorator metadata, never executed. The
// PDF renderer does not resolve in every environment (a known, unrelated
// dependency problem), so it is stubbed instead of making the inventory depend
// on it.
const mockPdfStub: unknown = new Proxy(function stub() {}, {
  get: (_target, prop) => (prop === '__esModule' ? true : mockPdfStub),
  apply: () => mockPdfStub,
});
jest.mock('@react-pdf/renderer', () => mockPdfStub);

type Ctor = new (...args: never[]) => object;
type Handler = (...args: never[]) => unknown;

/** Guards that authenticate a service (HMAC / shared secret), not a person. */
const SIGNED_SERVICE_GUARDS = ['FirmaPanelGuard'];

function guardName(guard: unknown): string {
  if (typeof guard === 'function') return guard.name;
  return (guard as { constructor: { name: string } }).constructor.name;
}

/** Class-level guards run before method-level ones, in declaration order. */
function guardNames(controller: Ctor, handler: Handler): string[] {
  const classGuards =
    (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];
  const methodGuards =
    (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
  return [...classGuards, ...methodGuards].map(guardName);
}

/**
 * A declared module must be a real product module; a list (`@ModuloAlguno`)
 * must be non-empty and made only of real ones, or the guard would deny (or
 * match) for the wrong reason.
 */
function moduloValido(modulo: string | string[]): boolean {
  const lista = typeof modulo === 'string' ? [modulo] : modulo;
  return (
    lista.length > 0 &&
    lista.every((m) => (MODULOS_PRODUCTO as readonly string[]).includes(m))
  );
}

function declared(key: string, controller: Ctor, handler: Handler): boolean {
  return (
    Reflect.getMetadata(key, handler) === true ||
    Reflect.getMetadata(key, controller) === true
  );
}

function hasRules(key: string, controller: Ctor, handler: Handler): boolean {
  const own = Reflect.getMetadata(key, handler) as unknown[] | undefined;
  const cls = Reflect.getMetadata(key, controller) as unknown[] | undefined;
  return (own ?? cls ?? []).length > 0;
}

/**
 * Returns why a route is unprotected, or null when it declares a valid policy.
 * Exactly one of: public, signed-service guard, platform-admin, authenticated-
 * only, or CASL rules under PoliciesGuard — and the auth guard must come first
 * wherever the later guard reads `request.user`.
 */
export function routeProblem(
  controller: Ctor,
  handler: Handler,
): string | null {
  const guards = guardNames(controller, handler);
  const at = (name: string) => guards.indexOf(name);

  if (declared(PUBLIC_KEY, controller, handler)) {
    return guards.length === 0 ? null : 'is @Public but also carries guards';
  }
  if (SIGNED_SERVICE_GUARDS.some((g) => guards.includes(g))) return null;

  if (at('FirebaseAuthGuard') === -1) {
    return 'has no auth guard and is not @Public or signed-service';
  }
  if (guards.includes('PlatformAdminGuard')) {
    return at('FirebaseAuthGuard') < at('PlatformAdminGuard')
      ? null
      : 'PlatformAdminGuard runs before FirebaseAuthGuard';
  }
  if (guards.includes('PortalGuard')) {
    if (at('FirebaseAuthGuard') > at('PortalGuard')) {
      return 'PortalGuard runs before FirebaseAuthGuard';
    }
    const modulo =
      (Reflect.getMetadata(MODULO_KEY, handler) as
        string | string[] | undefined) ??
      (Reflect.getMetadata(MODULO_KEY, controller) as
        string | string[] | undefined);
    if (!modulo) return 'under PortalGuard without @Modulo';
    return moduloValido(modulo) ? null : 'declares an unknown @Modulo';
  }
  if (guards.includes('PoliciesGuard')) {
    if (at('FirebaseAuthGuard') > at('PoliciesGuard')) {
      return 'PoliciesGuard runs before FirebaseAuthGuard';
    }
    const hasAbility =
      hasRules(CHECK_ABILITY_KEY, controller, handler) ||
      hasRules(CHECK_ANY_ABILITY_KEY, controller, handler);
    if (!hasAbility) return 'under PoliciesGuard without @CheckAbility';
    const modulo =
      (Reflect.getMetadata(MODULO_KEY, handler) as
        string | string[] | undefined) ??
      (Reflect.getMetadata(MODULO_KEY, controller) as
        string | string[] | undefined);
    if (!modulo) return 'under PoliciesGuard without @Modulo';
    return moduloValido(modulo) ? null : 'declares an unknown @Modulo';
  }
  return declared(AUTHENTICATED_ONLY_KEY, controller, handler)
    ? null
    : 'has FirebaseAuthGuard only: add @AuthenticatedOnly() or a permission';
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.controller.ts'))
    .map((e) => join(e.parentPath, e.name));
}

function routesOf(controller: Ctor): Array<[string, Handler]> {
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name): [string, Handler] => [
      name,
      (controller.prototype as Record<string, Handler>)[name],
    ])
    .filter(
      ([, fn]) =>
        typeof fn === 'function' &&
        Reflect.getMetadata(METHOD_METADATA, fn) !== undefined &&
        Reflect.getMetadata(PATH_METADATA, fn) !== undefined,
    );
}

describe('routeProblem (classifier)', () => {
  const Auth = class FirebaseAuthGuard {};
  const Policies = class PoliciesGuard {};
  const Admin = class PlatformAdminGuard {};

  function make(
    classGuards: unknown[],
    decorate?: (proto: object, key: string) => void,
  ): [Ctor, Handler] {
    class C {
      route() {
        return 1;
      }
    }
    if (classGuards.length) {
      Reflect.defineMetadata(GUARDS_METADATA, classGuards, C);
    }
    decorate?.(C.prototype, 'route');
    return [C, (C.prototype as { route: Handler }).route];
  }

  it('rechaza una ruta con PoliciesGuard pero sin @CheckAbility', () => {
    const [c, h] = make([Auth, Policies]);
    expect(routeProblem(c, h)).toBe(
      'under PoliciesGuard without @CheckAbility',
    );
  });

  it('acepta PoliciesGuard con @CheckAbility y @Modulo', () => {
    const [c, h] = make([Auth, Policies]);
    Reflect.defineMetadata(
      CHECK_ABILITY_KEY,
      [{ action: 'read', subject: 'Factura' }],
      h,
    );
    Reflect.defineMetadata(MODULO_KEY, 'finanzas', c);
    expect(routeProblem(c, h)).toBeNull();
  });

  it('rechaza PoliciesGuard con @CheckAbility pero sin @Modulo', () => {
    const [c, h] = make([Auth, Policies]);
    Reflect.defineMetadata(
      CHECK_ABILITY_KEY,
      [{ action: 'read', subject: 'Factura' }],
      h,
    );
    expect(routeProblem(c, h)).toBe('under PoliciesGuard without @Modulo');
  });

  it('acepta una lista de módulos (@ModuloAlguno) y rechaza una vacía o con un módulo desconocido', () => {
    const Portal = class PortalGuard {};
    const [c, h] = make([Auth, Portal]);
    Reflect.defineMetadata(MODULO_KEY, ['finanzas', 'administracion'], h);
    expect(routeProblem(c, h)).toBeNull();
    Reflect.defineMetadata(MODULO_KEY, [], h);
    expect(routeProblem(c, h)).toBe('declares an unknown @Modulo');
    Reflect.defineMetadata(MODULO_KEY, ['finanzas', 'otro'], h);
    expect(routeProblem(c, h)).toBe('declares an unknown @Modulo');
  });

  it('rechaza una ruta sin ningún guard y sin @Public', () => {
    const [c, h] = make([]);
    expect(routeProblem(c, h)).toMatch(/no auth guard/);
  });

  it('acepta @Public sin guards y rechaza @Public con guards', () => {
    const [c, h] = make([]);
    Reflect.defineMetadata(PUBLIC_KEY, true, h);
    expect(routeProblem(c, h)).toBeNull();
    const [c2, h2] = make([Auth]);
    Reflect.defineMetadata(PUBLIC_KEY, true, h2);
    expect(routeProblem(c2, h2)).toMatch(/also carries guards/);
  });

  it('rechaza solo FirebaseAuthGuard sin @AuthenticatedOnly', () => {
    const [c, h] = make([Auth]);
    expect(routeProblem(c, h)).toMatch(/AuthenticatedOnly/);
    Reflect.defineMetadata(AUTHENTICATED_ONLY_KEY, true, h);
    expect(routeProblem(c, h)).toBeNull();
  });

  it('acepta PortalGuard tras FirebaseAuthGuard con @Modulo, y rechaza sin @Modulo', () => {
    const Portal = class PortalGuard {};
    const [c, h] = make([Auth, Portal]);
    expect(routeProblem(c, h)).toBe('under PortalGuard without @Modulo');
    Reflect.defineMetadata(MODULO_KEY, 'finanzas', c);
    expect(routeProblem(c, h)).toBeNull();
    const [c2, h2] = make([Portal, Auth]);
    expect(routeProblem(c2, h2)).toBe(
      'PortalGuard runs before FirebaseAuthGuard',
    );
  });

  it('rechaza PlatformAdminGuard antes que FirebaseAuthGuard', () => {
    const [c, h] = make([Admin, Auth]);
    expect(routeProblem(c, h)).toMatch(/runs before/);
    const [c2, h2] = make([Auth, Admin]);
    expect(routeProblem(c2, h2)).toBeNull();
  });
});

describe('inventario de rutas', () => {
  const srcRoot = join(__dirname, '..', '..');
  const files = controllerFiles(srcRoot);

  it('encuentra los controladores', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('toda ruta HTTP declara su política de acceso', () => {
    const problems: string[] = [];
    const unloadable: string[] = [];
    let routes = 0;

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
        if (typeof exported !== 'function') continue;
        const controller = exported as unknown as Ctor;
        if (Reflect.getMetadata(PATH_METADATA, controller) === undefined) {
          continue;
        }
        for (const [name, handler] of routesOf(controller)) {
          routes += 1;
          const problem = routeProblem(controller, handler);
          if (problem) {
            problems.push(
              `${relative(srcRoot, file)} ${controller.name}.${name} ${problem}`,
            );
          }
        }
      }
    }

    expect(unloadable).toEqual([]);
    expect(routes).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  /**
   * Every route open to EITHER product (`@ModuloAlguno`). Sharing a route is a
   * commercial decision, so a new one fails here until it is added on purpose:
   * - portal unidades: every resident form starts from it, no financial data.
   * - equipo / roles: a team is managed whichever product the building bought.
   * - catalogo-permisos: the Finanzas key list those two screens draw.
   * - residentes/correos: owners and tenants get invoices under either
   *   product, so their portal access is managed under either. The old
   *   `/residentes` grant routes stay Administración only until removed.
   */
  it('las únicas rutas compartidas entre módulos (@ModuloAlguno) son las justificadas', () => {
    const compartidas: string[] = [];
    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file) as Record<string, unknown>;
      for (const exported of Object.values(mod)) {
        if (typeof exported !== 'function') continue;
        const controller = exported as unknown as Ctor;
        if (Reflect.getMetadata(PATH_METADATA, controller) === undefined) {
          continue;
        }
        for (const [name, handler] of routesOf(controller)) {
          const modulo =
            (Reflect.getMetadata(MODULO_KEY, handler) as unknown) ??
            (Reflect.getMetadata(MODULO_KEY, controller) as unknown);
          if (Array.isArray(modulo)) {
            compartidas.push(`${controller.name}.${name}`);
          }
        }
      }
    }
    expect(compartidas.sort()).toEqual([
      'CatalogoPermisosController.finanzas',
      'EquipoController.actualizar',
      'EquipoController.crear',
      'EquipoController.desactivar',
      'EquipoController.listar',
      'EquipoController.obtener',
      'EquipoController.reenviarInvitacion',
      'PortalController.unidades',
      'ResidentesCorreosController.listar',
      'ResidentesCorreosController.permitir',
      'ResidentesCorreosController.reenviar',
      'ResidentesCorreosController.revocar',
      'RolesController.create',
      'RolesController.findAll',
      'RolesController.permisos',
      'RolesController.remove',
      'RolesController.update',
    ]);
  });

  /**
   * Every unauthenticated route, each with why it must be open. A new @Public
   * route fails here until it is added on purpose.
   * - health: Cloud Run probes carry no credentials.
   * - auth/enlace/canjear: the person following an emailed link has no session
   *   yet; single purpose (token -> custom token), rate-limited, opaque 401.
   * - publico/facturas/pdf: the person following an emailed link has no
   *   account; it serves one PDF only (the invoice the link names), rate-limited
   *   per IP and per link, with one opaque 404 for every kind of refusal.
   * - auth/portal/solicitar: a resident asking for a sign-in link has no session
   *   yet; single purpose (address in, e-mail out), rate-limited per IP and per
   *   address, and ONE 202 at a fixed time whatever the address is (no
   *   enumeration).
   * - auth/portal/canjear: the explicit redeem of that link; single purpose
   *   (token -> custom token or confirmation), rate-limited per IP and per
   *   token hash, one opaque 401 for every refusal.
   */
  it('las únicas rutas @Public son las justificadas', () => {
    const publicas: string[] = [];
    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file) as Record<string, unknown>;
      for (const exported of Object.values(mod)) {
        if (typeof exported !== 'function') continue;
        const controller = exported as unknown as Ctor;
        if (Reflect.getMetadata(PATH_METADATA, controller) === undefined) {
          continue;
        }
        for (const [name, handler] of routesOf(controller)) {
          if (declared(PUBLIC_KEY, controller, handler)) {
            publicas.push(`${controller.name}.${name}`);
          }
        }
      }
    }
    expect(publicas.sort()).toEqual([
      'EnlaceAccesoController.canjear',
      'FacturaPublicaController.obtenerPdf',
      'HealthController.check',
      'HealthController.live',
      'HealthController.ready',
      'IngresoPortalController.canjear',
      'IngresoPortalController.solicitar',
    ]);
  });
});

/**
 * The two per-assignment routes of the platform Usuarios screen. They inherit
 * the class-level `FirebaseAuthGuard` + `PlatformAdminGuard` of
 * `UsuariosController`, which is the whole of their protection: no CASL rule
 * could stand for "deciding who else may operate the system".
 */
describe('rutas de asignaciones de /usuarios', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { UsuariosController } = require('../usuarios/usuarios.controller') as {
    UsuariosController: Ctor;
  };

  it.each(['agregarAsignacion', 'actualizarAsignacion'])(
    '%s es una ruta de administrador de plataforma, con la autenticación primero (S-U3.15)',
    (nombre) => {
      const rutas = new Map(routesOf(UsuariosController));
      const handler = rutas.get(nombre);

      expect(handler).toBeDefined();
      expect(guardNames(UsuariosController, handler!)).toEqual([
        'FirebaseAuthGuard',
        'PlatformAdminGuard',
      ]);
      expect(routeProblem(UsuariosController, handler!)).toBeNull();
    },
  );

  it('cuelgan de `:id/asignaciones` sin chocar con `:id`', () => {
    const rutas = new Map(routesOf(UsuariosController));
    expect(
      Reflect.getMetadata(PATH_METADATA, rutas.get('agregarAsignacion')!),
    ).toBe(':id/asignaciones');
    expect(
      Reflect.getMetadata(PATH_METADATA, rutas.get('actualizarAsignacion')!),
    ).toBe(':id/asignaciones/:asignacionId');
  });
});
