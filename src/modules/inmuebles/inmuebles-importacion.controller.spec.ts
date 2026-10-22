import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InmueblesController } from './inmuebles.controller';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { PoliciesGuard } from '../casl/policies.guard';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
} from '../casl/check-ability.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

// The controller imports the report service, which pulls in the PDF renderer
// (not loadable under jest) — the roster PDF is irrelevant here.
jest.mock('../../common/pdf/inmuebles-listado-pdf', () => ({
  generarPdfListadoInmuebles: jest.fn(),
}));

const handlerDe = (nombre: string): object =>
  Object.getOwnPropertyDescriptor(InmueblesController.prototype, nombre)
    ?.value as object;

const contextoDe = (nombre: string, user: IRequestUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handlerDe(nombre),
    getClass: () => InmueblesController,
  }) as unknown as ExecutionContext;

const usuarioCon = (permissions: string[]): IRequestUser => ({
  uid: 'uid-1',
  email: 'contador@ejemplo.com',
  permissions,
});

describe.each([
  'importar',
  'obtenerProgresoImportacion',
  'previsualizarImportacion',
])('InmueblesController.%s', (nombre) => {
  it('exige crear Inmueble Y editar Inmueble (AND), sin reglas OR y sin Tercero', () => {
    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handlerDe(nombre))).toEqual([
      { action: 'create', subject: 'Inmueble' },
      { action: 'update', subject: 'Inmueble' },
    ]);
    expect(
      Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handlerDe(nombre)),
    ).toBeUndefined();
  });

  describe('con el PoliciesGuard real', () => {
    const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

    it('deniega (403) a quien solo puede crear inmuebles', () => {
      expect(() =>
        guard.canActivate(contextoDe(nombre, usuarioCon(['inmuebles.crear']))),
      ).toThrow(ForbiddenException);
    });

    it('deniega (403) a quien solo puede editar inmuebles', () => {
      expect(() =>
        guard.canActivate(contextoDe(nombre, usuarioCon(['inmuebles.editar']))),
      ).toThrow(ForbiddenException);
    });

    it('permite a quien puede crear y editar inmuebles, sin necesitar permisos de Tercero', () => {
      expect(
        guard.canActivate(
          contextoDe(
            nombre,
            usuarioCon(['inmuebles.crear', 'inmuebles.editar']),
          ),
        ),
      ).toBe(true);
    });
  });
});

describe('InmueblesController.previsualizarImportacion — ruta', () => {
  it('se sirve en POST importar/previsualizar y ninguna ruta POST con parámetro puede tragársela', () => {
    const metodos = Object.getOwnPropertyNames(InmueblesController.prototype);

    expect(
      Reflect.getMetadata('path', handlerDe('previsualizarImportacion')),
    ).toBe('importar/previsualizar');
    expect(
      Reflect.getMetadata('method', handlerDe('previsualizarImportacion')),
    ).toBe(1); // RequestMethod.POST
    // El `:id` de findOne es GET: no compite. Lo que importa es que no exista
    // un POST `:id` (o similar) que capture "importar/previsualizar".
    const postsConParametro = metodos.filter(
      (m) =>
        Reflect.getMetadata('method', handlerDe(m)) === 1 &&
        String(Reflect.getMetadata('path', handlerDe(m))).startsWith(':'),
    );
    expect(postsConParametro).toEqual([]);
  });

  it('delega en el servicio con el mismo cuerpo que importar', async () => {
    const respuesta = { total: 1 };
    const servicio = {
      previsualizarImportacion: jest.fn().mockResolvedValue(respuesta),
    };
    const controlador = new InmueblesController(
      servicio as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const dto = { filas: [] };

    await expect(controlador.previsualizarImportacion(dto)).resolves.toBe(
      respuesta,
    );
    expect(servicio.previsualizarImportacion).toHaveBeenCalledWith(dto);
  });
});

describe('InmueblesController.darDeBaja', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

  it('exige solo editar Inmueble (update), sin reglas OR', () => {
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, handlerDe('darDeBaja')),
    ).toEqual([{ action: 'update', subject: 'Inmueble' }]);
    expect(
      Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handlerDe('darDeBaja')),
    ).toBeUndefined();
  });

  it('se sirve en POST dar-de-baja', () => {
    expect(Reflect.getMetadata('path', handlerDe('darDeBaja'))).toBe(
      'dar-de-baja',
    );
    expect(Reflect.getMetadata('method', handlerDe('darDeBaja'))).toBe(1);
  });

  it('deniega (403) a quien solo puede crear inmuebles', () => {
    expect(() =>
      guard.canActivate(
        contextoDe('darDeBaja', usuarioCon(['inmuebles.crear'])),
      ),
    ).toThrow(ForbiddenException);
  });

  it('deniega (403) a quien solo puede ver inmuebles', () => {
    expect(() =>
      guard.canActivate(contextoDe('darDeBaja', usuarioCon(['inmuebles.ver']))),
    ).toThrow(ForbiddenException);
  });

  it('permite a quien puede editar inmuebles', () => {
    expect(
      guard.canActivate(
        contextoDe('darDeBaja', usuarioCon(['inmuebles.editar'])),
      ),
    ).toBe(true);
  });

  it('delega en el servicio con el actor (cuenta y nombre, o el email si no hay nombre)', async () => {
    const respuesta = { solicitados: 1 };
    const baja = { darDeBaja: jest.fn().mockResolvedValue(respuesta) };
    const controlador = new InmueblesController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      baja as never,
    );
    const dto = { codigos: ['301'] };

    await controlador.darDeBaja(dto, {
      uid: 'u',
      email: 'ana@ejemplo.com',
      accountId: 'acc-1',
      nombre: ' Ana ',
    });
    await controlador.darDeBaja(dto, {
      uid: 'u',
      email: 'ana@ejemplo.com',
      accountId: 'acc-1',
    });

    expect(baja.darDeBaja).toHaveBeenNthCalledWith(1, dto, {
      accountId: 'acc-1',
      nombre: 'Ana',
    });
    expect(baja.darDeBaja).toHaveBeenNthCalledWith(2, dto, {
      accountId: 'acc-1',
      nombre: 'ana@ejemplo.com',
    });
  });
});
