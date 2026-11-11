// src/modules/casl/permisos-finanzas.spec.ts
//
// The Finanzas permission catalog (`PERMISOS_FINANZAS`) is HAND-KEPT in
// `permisos-catalogo.ts`, so this spec is what keeps it honest: it reads the
// same route metadata Nest enforces (`@CheckAbility` / `@CheckAnyAbility`, as
// `route-policies.spec.ts` does) and fails when the two drift apart, in BOTH
// directions:
//   - a route demands a (subject, action) no catalog key can grant -> nobody
//     could be given access to that route from the matrix;
//   - the catalog offers a key whose (subject, action) no route demands -> the
//     matrix shows a checkbox that grants nothing anybody checks.
import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  createAppAbility,
  type Action,
  type Subject,
} from './casl-ability.constants';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  type RequiredRule,
} from './check-ability.decorator';
import { MODULE_TO_SUBJECT, rulesFromPermissionKeys } from './permission-map';
import {
  moduloDePermiso,
  PERMISOS_FINANZAS,
  esPermisoFinanzas,
} from './permisos-catalogo';

// Controllers are only imported to read decorator metadata, never executed
// (same stub and reason as route-policies.spec.ts).
const mockPdfStub: unknown = new Proxy(function stub() {}, {
  get: (_target, prop) => (prop === '__esModule' ? true : mockPdfStub),
  apply: () => mockPdfStub,
});
jest.mock('@react-pdf/renderer', () => mockPdfStub);

type Ctor = new (...args: never[]) => object;
type Handler = (...args: never[]) => unknown;

const SUJETOS_FINANCIEROS = new Set<Subject>(Object.values(MODULE_TO_SUBJECT));

/** Every (subject, action) pair some HTTP route of the backend requires. */
function paresExigidosPorRutas(): Map<string, string[]> {
  const srcRoot = join(__dirname, '..', '..');
  const archivos = readdirSync(srcRoot, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((e) => e.isFile() && e.name.endsWith('.controller.ts'))
    .map((e) => join(e.parentPath, e.name));

  const pares = new Map<string, string[]>();
  const anotar = (regla: RequiredRule, ruta: string): void => {
    const par = `${regla.subject}:${regla.action}`;
    pares.set(par, [...(pares.get(par) ?? []), ruta]);
  };

  for (const archivo of archivos) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(archivo) as Record<string, unknown>;
    for (const exportado of Object.values(mod)) {
      if (typeof exportado !== 'function') continue;
      const controlador = exportado as unknown as Ctor;
      if (Reflect.getMetadata(PATH_METADATA, controlador) === undefined) {
        continue;
      }
      const proto = controlador.prototype as Record<string, Handler>;
      for (const nombre of Object.getOwnPropertyNames(proto)) {
        const manejador = proto[nombre];
        if (
          nombre === 'constructor' ||
          typeof manejador !== 'function' ||
          Reflect.getMetadata(METHOD_METADATA, manejador) === undefined ||
          Reflect.getMetadata(PATH_METADATA, manejador) === undefined
        ) {
          continue;
        }
        for (const clave of [CHECK_ABILITY_KEY, CHECK_ANY_ABILITY_KEY]) {
          const reglas = (Reflect.getMetadata(clave, manejador) ??
            Reflect.getMetadata(clave, controlador) ??
            []) as RequiredRule[];
          for (const regla of reglas) {
            anotar(regla, `${controlador.name}.${nombre}`);
          }
        }
      }
    }
  }
  return pares;
}

/** Whether holding ONLY `clave` lets the caller do `action` on `subject`. */
const concede = (clave: string, action: Action, subject: Subject): boolean =>
  createAppAbility(rulesFromPermissionKeys([clave])).can(action, subject);

describe('PERMISOS_FINANZAS frente a las rutas del backend', () => {
  const exigidos = paresExigidosPorRutas();
  const financieros = [...exigidos.entries()]
    .map(([par, rutas]) => {
      const [subject, action] = par.split(':') as [Subject, Action];
      return { subject, action, rutas };
    })
    .filter(({ subject }) => SUJETOS_FINANCIEROS.has(subject));

  it('encuentra las rutas con permisos financieros (el escáner no está vacío)', () => {
    expect(financieros.length).toBeGreaterThan(40);
  });

  it('toda acción que una ruta exige sobre una materia financiera la concede alguna clave del catálogo', () => {
    const sinClave = financieros
      .filter(
        ({ subject, action }) =>
          !PERMISOS_FINANZAS.some((clave) => concede(clave, action, subject)),
      )
      .map(
        ({ subject, action, rutas }) =>
          `${subject}.${action} (${rutas.slice(0, 2).join(', ')})`,
      );
    expect(sinClave).toEqual([]);
  });

  it('toda clave del catálogo concede algo que alguna ruta exige (ninguna casilla muerta)', () => {
    const exigeAlgunaRuta = (subject: Subject, action: Action): boolean =>
      financieros.some((f) => f.subject === subject && f.action === action);

    const muertas = PERMISOS_FINANZAS.filter((clave) => {
      const modulo = clave.split('.')[0] as keyof typeof MODULE_TO_SUBJECT;
      const subject = MODULE_TO_SUBJECT[modulo];
      // The only actions a single Finanzas key can grant are the ones in the
      // financial vocabulary. `manage` is not among them: no Finanzas key maps
      // to it, so a key can never stand in for "every action" (see the pin below).
      const acciones: Action[] = [
        'read',
        'create',
        'update',
        'annul',
        'approve',
        'export',
        'purge',
      ];
      const concedidas = acciones.filter((a) => concede(clave, a, subject));
      return !concedidas.some((a) => exigeAlgunaRuta(subject, a));
    });
    expect(muertas).toEqual([]);
  });

  it('ninguna ruta financiera exige `manage`: ninguna clave de Finanzas la podría conceder', () => {
    // Finanzas has no `gestionar` verb. A route asking `manage` on a financial
    // subject would be reachable by a platform admin only, so this fails the
    // moment someone writes one (use a real action, e.g. `purge`, instead).
    const conManage = financieros
      .filter(({ action }) => action === 'manage')
      .map(
        ({ subject, rutas }) => `${subject} (${rutas.slice(0, 2).join(', ')})`,
      );
    expect(conManage).toEqual([]);
  });
});

describe('PERMISOS_FINANZAS (catálogo de claves reales)', () => {
  it('no repite claves y todas son de Finanzas según la gramática', () => {
    expect(new Set(PERMISOS_FINANZAS).size).toBe(PERMISOS_FINANZAS.length);
    for (const clave of PERMISOS_FINANZAS) {
      expect(moduloDePermiso(clave)).toBe('finanzas');
    }
  });

  it('esPermisoFinanzas distingue una clave real de una sin sentido', () => {
    expect(esPermisoFinanzas('facturas.aprobar')).toBe(true);
    expect(esPermisoFinanzas('inmuebles.aprobar')).toBe(false);
    expect(esPermisoFinanzas('pqr.ver')).toBe(false);
  });

  it('las combinaciones sin sentido NO están: un inmueble no se aprueba ni un recibo se edita', () => {
    for (const absurda of [
      'inmuebles.aprobar',
      'inmuebles.anular',
      'terceros.anular',
      'conceptos.aprobar',
      'recibos.editar',
      'recibos.depurar',
      'terceros.depurar',
      'consultas.crear',
      'consultas.editar',
      'cuentas-contables.anular',
      'documentos.aprobar',
      'notas-contables.editar',
      'saldos-iniciales.editar',
    ]) {
      expect(PERMISOS_FINANZAS).not.toContain(absurda);
    }
  });

  it('las que sí existen están: aprobar facturas, anular recibos, aprobar el lote de recibos, depurar', () => {
    for (const real of [
      'facturas.aprobar',
      'recibos.aprobar',
      'inmuebles.depurar',
      'conceptos.depurar',
      'facturas.depurar',
      'facturas.anular',
      'recibos.anular',
      'notas-credito.editar',
      'inmuebles.editar',
      'consultas.ver',
      'interfaz-comptable.anular',
      'cuentas-contables.editar',
    ]) {
      expect(PERMISOS_FINANZAS).toContain(real);
    }
  });

  it('un módulo sin ninguna ruta (anulaciones) no ofrece ninguna clave', () => {
    expect(
      PERMISOS_FINANZAS.filter((c) => c.startsWith('anulaciones.')),
    ).toEqual([]);
  });

  it('los módulos que comparten materia (Configuracion) ofrecen las mismas acciones', () => {
    const acciones = (modulo: string): string[] =>
      PERMISOS_FINANZAS.filter((c) => c.startsWith(`${modulo}.`)).map(
        (c) => c.split('.')[1],
      );
    const referencia = acciones('cuentas-contables');
    expect(referencia).toEqual(['ver', 'crear', 'editar']);
    for (const modulo of [
      'parametros-facturacion',
      'documentos',
      'adicion-contabilidad',
    ]) {
      expect(acciones(modulo)).toEqual(referencia);
    }
  });

  it('cuenta las claves reales (56 de las 126 combinaciones módulo x verbo)', () => {
    expect(PERMISOS_FINANZAS).toHaveLength(56);
  });

  it('ninguna clave ofrecida es `gestionar`: en Finanzas ya no es una clave', () => {
    expect(PERMISOS_FINANZAS.filter((c) => c.endsWith('.gestionar'))).toEqual(
      [],
    );
    expect(esPermisoFinanzas('facturas.gestionar')).toBe(false);
  });

  it('las cuatro claves que reemplazan a `gestionar` están ofrecidas', () => {
    for (const nueva of [
      'inmuebles.depurar',
      'conceptos.depurar',
      'facturas.depurar',
      'recibos.aprobar',
    ]) {
      expect(PERMISOS_FINANZAS).toContain(nueva);
    }
  });

  it('`depurar` solo se ofrece donde existe un borrado previo al documento', () => {
    expect(
      PERMISOS_FINANZAS.filter((c) => c.endsWith('.depurar')).sort(),
    ).toEqual(['conceptos.depurar', 'facturas.depurar', 'inmuebles.depurar']);
  });
});
