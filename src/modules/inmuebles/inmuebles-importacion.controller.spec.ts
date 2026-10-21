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

describe.each(['importar', 'obtenerProgresoImportacion'])(
  'InmueblesController.%s',
  (nombre) => {
    it('exige crear Inmueble Y editar Inmueble (AND), sin reglas OR y sin Tercero', () => {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handlerDe(nombre))).toEqual(
        [
          { action: 'create', subject: 'Inmueble' },
          { action: 'update', subject: 'Inmueble' },
        ],
      );
      expect(
        Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handlerDe(nombre)),
      ).toBeUndefined();
    });

    describe('con el PoliciesGuard real', () => {
      const guard = new PoliciesGuard(
        new Reflector(),
        new CaslAbilityFactory(),
      );

      it('deniega (403) a quien solo puede crear inmuebles', () => {
        expect(() =>
          guard.canActivate(
            contextoDe(nombre, usuarioCon(['inmuebles.crear'])),
          ),
        ).toThrow(ForbiddenException);
      });

      it('deniega (403) a quien solo puede editar inmuebles', () => {
        expect(() =>
          guard.canActivate(
            contextoDe(nombre, usuarioCon(['inmuebles.editar'])),
          ),
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
  },
);
