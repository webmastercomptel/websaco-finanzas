import 'reflect-metadata';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  ForbiddenException,
  RequestMethod,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { rulesFromPermissionKeys } from '../casl/permission-map';
import {
  PERMISOS_ADMINISTRACION,
  sinPermisosVetados,
  type PerfilAsignacion,
} from '../casl/permisos-catalogo';
import { PoliciesGuard } from '../casl/policies.guard';
import { FacturacionBloqueController } from './facturacion-bloque.controller';

const prototipo = FacturacionBloqueController.prototype as unknown as Record<
  string,
  object
>;

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof FacturacionBloqueController) =>
  Reflect.getMetadata(CHECK_ABILITY_KEY, prototipo[handler]) as RequiredRule[];

describe('FacturacionBloqueController — política de acceso', () => {
  it('conserva la ruta del sistema original', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, FacturacionBloqueController),
    ).toBe('facturacion-bloque');
  });

  it.each([
    ['listar', 'create'],
    ['crear', 'create'],
    ['detalle', 'create'],
    ['confirmar', 'create'],
    ['descargar', 'create'],
    ['enviar', 'approve'],
    ['eliminar', 'approve'],
  ] as const)('%s exige la acción %s sobre Factura', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Factura' }]);
  });

  it('NINGUNA ruta de staff se abre con read: quien solo ve facturas no ve los PDF de todas las unidades', () => {
    const rutas = Object.getOwnPropertyNames(prototipo).filter(
      (n) => n !== 'constructor',
    ) as Array<keyof FacturacionBloqueController>;
    for (const ruta of rutas) {
      expect(reglasDe(ruta).map((r) => r.action)).not.toContain('read');
    }
  });

  it('expone exactamente las rutas esperadas con su verbo y su camino', () => {
    const rutas = Object.getOwnPropertyNames(prototipo)
      .filter((n) => n !== 'constructor')
      .filter(
        (n) => Reflect.getMetadata(METHOD_METADATA, prototipo[n]) !== undefined,
      )
      .map((n) => [
        n,
        RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, prototipo[n]) as number
        ],
        String(Reflect.getMetadata(PATH_METADATA, prototipo[n])),
      ])
      .sort();

    expect(rutas).toEqual([
      ['confirmar', 'PATCH', ':id/confirmar'],
      ['crear', 'POST', '/'],
      ['descargar', 'GET', ':id/descargar'],
      ['detalle', 'GET', ':id'],
      ['eliminar', 'DELETE', ':id'],
      ['enviar', 'POST', ':id/enviar'],
      ['listar', 'GET', '/'],
    ]);
  });

  it('enviar responde 200 (es una acción, no la creación de un recurso)', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, prototipo.enviar)).toBe(200);
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, FacturacionBloqueController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(
        GUARDS_METADATA,
        FacturacionBloqueController,
      ) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('crear (facturas.crear) NO alcanza para enviar ni borrar; aprobar sí', () => {
    const crear = rulesFromPermissionKeys(['facturas.crear']).filter(
      (r) => !r.inverted,
    );
    const aprobar = rulesFromPermissionKeys(['facturas.aprobar']).filter(
      (r) => !r.inverted,
    );

    expect(crear).toEqual([{ action: 'create', subject: 'Factura' }]);
    expect(aprobar).toEqual([{ action: 'approve', subject: 'Factura' }]);
  });
});

describe('FacturacionBloqueController — techo de Finanzas (perfil personal)', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());
  const rutas = Object.getOwnPropertyNames(prototipo).filter(
    (n) => n !== 'constructor',
  ) as Array<keyof FacturacionBloqueController>;

  /** Runs the real guard as it runs per request, after the ceiling trimmed the keys. */
  const pasa = (
    handler: keyof FacturacionBloqueController,
    perfil: PerfilAsignacion,
    claves: string[],
  ): boolean => {
    const user: IRequestUser = {
      uid: 'u',
      email: 'a@b.co',
      accountId: 'cuenta-1',
      copropiedadId: 'c1',
      modulos: ['finanzas', 'administracion'],
      permissions: sinPermisosVetados(perfil, claves),
    };
    const contexto = {
      getHandler: () => prototipo[handler],
      getClass: () => FacturacionBloqueController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    try {
      return guard.canActivate(contexto);
    } catch (e) {
      if (e instanceof ForbiddenException) return false;
      throw e;
    }
  };

  const todasLasDeAdministracion = PERMISOS_ADMINISTRACION.map((p) => p.id);

  it.each(rutas)(
    'personal con TODAS las claves de Administración recibe 403 en %s',
    (ruta) => {
      expect(pasa(ruta, 'personal', todasLasDeAdministracion)).toBe(false);
    },
  );

  it.each(rutas)(
    'personal con claves de facturas (recortadas por el techo) recibe 403 en %s',
    (ruta) => {
      expect(
        pasa(ruta, 'personal', ['facturas.crear', 'facturas.aprobar']),
      ).toBe(false);
    },
  );

  it.each(rutas)(
    'administrativo con facturas.crear y facturas.aprobar entra a %s',
    (ruta) => {
      expect(
        pasa(ruta, 'administrativo', ['facturas.crear', 'facturas.aprobar']),
      ).toBe(true);
    },
  );
});

describe('FacturacionBloqueController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    accountId: 'cuenta-1',
    nombre: 'Ana',
  };

  function montar() {
    const bloques = {
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({}),
      detalle: jest.fn().mockResolvedValue({}),
      descargarOriginal: jest.fn().mockResolvedValue({}),
      eliminar: jest.fn().mockResolvedValue({ id: 'b1' }),
    };
    const ingesta = { procesar: jest.fn().mockResolvedValue({}) };
    const entrega = { enviar: jest.fn().mockResolvedValue({}) };
    return {
      bloques,
      ingesta,
      entrega,
      controlador: new FacturacionBloqueController(
        bloques as never,
        ingesta as never,
        entrega as never,
      ),
    };
  }

  it('confirmar solo procesa: NO toca el servicio de envío (nada sale sin la acción explícita)', async () => {
    const { controlador, ingesta, entrega } = montar();

    await controlador.confirmar('b1');

    expect(ingesta.procesar).toHaveBeenCalledWith('b1');
    expect(entrega.enviar).not.toHaveBeenCalled();
  });

  it('enviar delega el id y el usuario autenticado: quién envía lo decide la cuenta, no el cliente', async () => {
    const { controlador, entrega, ingesta } = montar();

    await controlador.enviar('b1', user);

    expect(entrega.enviar).toHaveBeenCalledWith('b1', user);
    expect(ingesta.procesar).not.toHaveBeenCalled();
  });

  it('crear pasa el usuario autenticado; listar pasa los filtros; eliminar y descargar, el id', async () => {
    const { controlador, bloques } = montar();
    const cuerpo = {
      tipo: 'factura' as const,
      periodo: '2026-07',
      nombre: 'a.pdf',
      mimeType: 'application/pdf' as const,
      tamanoBytes: 10,
    };

    await controlador.crear(cuerpo, user);
    await controlador.listar({ estado: 'generado' });
    await controlador.detalle('b1');
    await controlador.descargar('b1');
    await controlador.eliminar('b1');

    expect(bloques.crear).toHaveBeenCalledWith(cuerpo, user);
    expect(bloques.listar).toHaveBeenCalledWith({ estado: 'generado' });
    expect(bloques.detalle).toHaveBeenCalledWith('b1');
    expect(bloques.descargarOriginal).toHaveBeenCalledWith('b1');
    expect(bloques.eliminar).toHaveBeenCalledWith('b1');
  });
});
