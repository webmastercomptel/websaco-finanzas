import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { CHECK_ABILITY_KEY, MODULO_KEY } from '../casl/check-ability.decorator';
import { FacturacionBloquePortalController } from './facturacion-bloque-portal.controller';

const prototipo =
  FacturacionBloquePortalController.prototype as unknown as Record<
    string,
    object
  >;

describe('FacturacionBloquePortalController — política de acceso', () => {
  it('cuelga de portal/mis-documentos', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, FacturacionBloquePortalController),
    ).toBe('portal/mis-documentos');
  });

  it('declara el módulo administracion y los guards en orden: autenticación y luego el portal (nunca CASL)', () => {
    expect(
      Reflect.getMetadata(MODULO_KEY, FacturacionBloquePortalController),
    ).toBe('administracion');
    const guards = (
      Reflect.getMetadata(
        GUARDS_METADATA,
        FacturacionBloquePortalController,
      ) as Array<{ name: string }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PortalGuard']);
  });

  it('no declara @CheckAbility en ninguna ruta: el residente no tiene permisos CASL', () => {
    for (const nombre of Object.getOwnPropertyNames(prototipo)) {
      if (nombre === 'constructor') continue;
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, prototipo[nombre])).toBe(
        undefined,
      );
    }
  });

  it('solo expone lecturas: listar y descargar, ninguna escritura', () => {
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
      ['descargar', 'GET', ':id/descarga'],
      ['listar', 'GET', '/'],
    ]);
  });
});

describe('FacturacionBloquePortalController — delegación', () => {
  it('pasa filtros y usuario al listar, e id y usuario al descargar: la identidad sale de la sesión', async () => {
    const servicio = {
      listar: jest.fn().mockResolvedValue([]),
      descargar: jest.fn().mockResolvedValue({ url: 'u', nombre: 'n' }),
    };
    const controlador = new FacturacionBloquePortalController(
      servicio as never,
    );
    const user = { uid: 'u', email: 'r@b.co', accountId: 'c1' };

    await controlador.listar({ tipo: 'factura' }, user);
    await controlador.descargar('d1', user);

    expect(servicio.listar).toHaveBeenCalledWith({ tipo: 'factura' }, user);
    expect(servicio.descargar).toHaveBeenCalledWith('d1', user);
  });
});
