import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PERMISOS_FINANZAS } from '../casl/permisos-catalogo';
import { guardDejaPasar } from '../casl/testing/politica-de-ruta';
import { UsuariosController } from '../usuarios/usuarios.controller';
import { CatalogoPermisosController } from './catalogo-permisos.controller';

const proto = CatalogoPermisosController.prototype as unknown as Record<
  string,
  object
>;

describe('CatalogoPermisosController.finanzas', () => {
  const controller = new CatalogoPermisosController();

  it('devuelve exactamente el catálogo de Finanzas: 56 claves, sin `gestionar`, con las cuatro nuevas', () => {
    const { claves } = controller.finanzas();

    expect(claves).toEqual([...PERMISOS_FINANZAS]);
    expect(claves).toHaveLength(56);
    expect(claves.some((c) => c.endsWith('.gestionar'))).toBe(false);
    for (const nueva of [
      'inmuebles.depurar',
      'conceptos.depurar',
      'facturas.depurar',
      'recibos.aprobar',
    ]) {
      expect(claves).toContain(nueva);
    }
  });

  it('es el mismo conjunto, en el mismo orden, que `/usuarios/permisos-finanzas` (contrato)', () => {
    const deUsuarios = new UsuariosController({} as never).permisosFinanzas();

    expect(controller.finanzas()).toEqual(deUsuarios);
  });

  it('entrega una copia: quien la modifique no cambia el catálogo', () => {
    const { claves } = controller.finanzas();
    claves.push('inventada.ver');
    claves.length = 0;

    expect(controller.finanzas().claves).toHaveLength(56);
    expect(PERMISOS_FINANZAS).toHaveLength(56);
  });

  it('no lee datos de la copropiedad: no recibe servicios', () => {
    expect(CatalogoPermisosController.length).toBe(0);
  });
});

describe('CatalogoPermisosController — política de acceso', () => {
  it('cuelga de catalogo-permisos/finanzas (GET) con los guards en orden', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CatalogoPermisosController)).toBe(
      'catalogo-permisos',
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.finanzas)).toBe('finanzas');
    expect(
      RequestMethod[
        Reflect.getMetadata(METHOD_METADATA, proto.finanzas) as number
      ],
    ).toBe('GET');
    const guards = (
      Reflect.getMetadata(
        GUARDS_METADATA,
        CatalogoPermisosController,
      ) as Array<{ name: string }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('declara la lista de módulos y una política "cualquiera de": leer o crear o editar Usuario, o leer Rol', () => {
    expect(Reflect.getMetadata(MODULO_KEY, CatalogoPermisosController)).toEqual(
      ['finanzas', 'administracion'],
    );
    expect(
      Reflect.getMetadata(
        CHECK_ANY_ABILITY_KEY,
        proto.finanzas,
      ) as RequiredRule[],
    ).toEqual([
      { action: 'read', subject: 'Usuario' },
      { action: 'create', subject: 'Usuario' },
      { action: 'update', subject: 'Usuario' },
      { action: 'read', subject: 'Rol' },
    ]);
    // Any-of only: no AND rule hides in the handler.
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, proto.finanzas),
    ).toBeUndefined();
  });

  it.each([
    ['usuarios.ver'],
    ['usuarios.crear'],
    ['usuarios.editar'],
    ['roles.ver'],
    ['roles.gestionar'],
  ])('%s abre la ruta, en una copropiedad solo con finanzas', (clave) => {
    expect(
      guardDejaPasar(CatalogoPermisosController, 'finanzas', [clave], {
        modulos: ['finanzas'],
      }),
    ).toBe(true);
  });

  it('también abre en una copropiedad solo con administracion', () => {
    expect(
      guardDejaPasar(CatalogoPermisosController, 'finanzas', ['usuarios.ver'], {
        modulos: ['administracion'],
      }),
    ).toBe(true);
  });

  it('ni usuarios.* ni roles.* (p. ej. solo usuarios.eliminar, pqr.ver o facturas.ver) responde 403', () => {
    for (const claves of [
      [],
      ['usuarios.eliminar'],
      ['pqr.ver'],
      ['facturas.ver'],
    ]) {
      expect(
        guardDejaPasar(CatalogoPermisosController, 'finanzas', claves, {
          modulos: ['finanzas', 'administracion'],
        }),
      ).toBe(false);
    }
  });

  it('sin ninguno de los dos módulos responde 403, aunque tenga la clave', () => {
    expect(
      guardDejaPasar(CatalogoPermisosController, 'finanzas', ['usuarios.ver'], {
        modulos: [],
      }),
    ).toBe(false);
  });
});
