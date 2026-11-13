// src/modules/casl/testing/politica-de-ruta.ts
//
// Specs-only helpers to pin the access policy of ONE route against the real
// `PoliciesGuard`: which (action, subject) the handler declares, and who gets
// through. The route specs of the guarded hard deletes share it so each one
// states only the key that opens its route.

import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../../common/interfaces/request-user.interface';
import { CaslAbilityFactory } from '../casl-ability.factory';
import {
  CHECK_ABILITY_KEY,
  type RequiredRule,
} from '../check-ability.decorator';
import { PoliciesGuard } from '../policies.guard';

type Controlador = abstract new (...args: never[]) => object;

/** The rules a handler declares with `@CheckAbility`, read from Nest's metadata. */
export function reglasDeRuta(
  controlador: Controlador,
  handler: string,
): RequiredRule[] {
  const prototipo = controlador.prototype as Record<string, object>;
  return (Reflect.getMetadata(CHECK_ABILITY_KEY, prototipo[handler]) ??
    []) as RequiredRule[];
}

/** What `describirRutaGuardada` pins for one route. */
export interface RutaGuardada {
  controlador: Controlador;
  handler: string;
  /** The single (action, subject) the route must require. */
  regla: RequiredRule;
  /** The key that opens the route (and nothing else of its module). */
  claveQueAbre: string;
  /** Real keys of the same module that must NOT open it. */
  clavesQueNoAbren: string[];
  /**
   * What an account that held the old `x.gestionar` carries once the conversion
   * script ran: it must keep access to the route.
   */
  clavesConvertidas: string[];
  /** The retired `x.gestionar` key, which must open nothing any more. */
  gestionarViejo: string;
}

/**
 * Registers the Amendment G pins of a route that used to require `manage`:
 * it asks the new action, the new key opens it, other keys of the module and the
 * retired `gestionar` do not, a converted account and a platform admin still
 * pass, and the Finanzas licence is still required.
 */
export function describirRutaGuardada(
  nombre: string,
  ruta: RutaGuardada,
): void {
  const { controlador, handler } = ruta;
  describe(nombre, () => {
    it(`exige ${ruta.regla.action} ${ruta.regla.subject}, nunca manage`, () => {
      expect(reglasDeRuta(controlador, handler)).toEqual([ruta.regla]);
    });

    it(`${ruta.claveQueAbre} abre la ruta`, () => {
      expect(guardDejaPasar(controlador, handler, [ruta.claveQueAbre])).toBe(
        true,
      );
    });

    it('otras claves del mismo módulo no la abren', () => {
      expect(guardDejaPasar(controlador, handler, ruta.clavesQueNoAbren)).toBe(
        false,
      );
    });

    it('una cuenta convertida (con las claves reales del módulo) conserva el acceso', () => {
      expect(guardDejaPasar(controlador, handler, ruta.clavesConvertidas)).toBe(
        true,
      );
    });

    it(`un ${ruta.gestionarViejo} guardado sin convertir no abre nada: clave desconocida = denegar`, () => {
      expect(guardDejaPasar(controlador, handler, [ruta.gestionarViejo])).toBe(
        false,
      );
    });

    it('el administrador de plataforma pasa', () => {
      expect(
        guardDejaPasar(controlador, handler, [], { isPlatformAdmin: true }),
      ).toBe(true);
    });

    it('sin el módulo finanzas contratado no pasa, ni con la clave', () => {
      expect(
        guardDejaPasar(controlador, handler, [ruta.claveQueAbre], {
          modulos: ['administracion'],
        }),
      ).toBe(false);
    });
  });
}

/**
 * Whether the real `PoliciesGuard` lets a caller holding `permisos` through the
 * route. The coproperty is licensed for Finanzas (the module of every route that
 * uses this helper); a platform admin is expressed with `extra`.
 */
export function guardDejaPasar(
  controlador: Controlador,
  handler: string,
  permisos: string[],
  extra: Partial<IRequestUser> = {},
): boolean {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());
  const prototipo = controlador.prototype as Record<string, object>;
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    permissions: permisos,
    modulos: ['finanzas'],
    ...extra,
  };
  const contexto = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => prototipo[handler],
    getClass: () => controlador,
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(contexto);
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
}
