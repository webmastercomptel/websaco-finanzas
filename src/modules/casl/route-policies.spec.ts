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
const SIGNED_SERVICE_GUARDS = [
  'FirmaWebsaco3Guard',
  'SecretoProgramadorGuard',
  'FirmaPanelGuard',
];

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
  if (guards.includes('PoliciesGuard')) {
    if (at('FirebaseAuthGuard') > at('PoliciesGuard')) {
      return 'PoliciesGuard runs before FirebaseAuthGuard';
    }
    const hasAbility =
      hasRules(CHECK_ABILITY_KEY, controller, handler) ||
      hasRules(CHECK_ANY_ABILITY_KEY, controller, handler);
    if (!hasAbility) return 'under PoliciesGuard without @CheckAbility';
    const modulo =
      (Reflect.getMetadata(MODULO_KEY, handler) as string | undefined) ??
      (Reflect.getMetadata(MODULO_KEY, controller) as string | undefined);
    return modulo ? null : 'under PoliciesGuard without @Modulo';
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
});
