// src/modules/casl/check-ability.decorator.ts
import { SetMetadata } from '@nestjs/common';
import type { Action, Subject } from './casl-ability.constants';
import type { ModuloProducto } from '../../common/licencia/modulos';

/** Metadata key holding the ability rules a handler requires. */
export const CHECK_ABILITY_KEY = 'check_ability';

/** One (action, subject) pair the caller must be able to perform. */
export interface RequiredRule {
  action: Action;
  subject: Subject;
}

/**
 * Declares the abilities a route requires. Multiple rules are ALL required
 * (logical AND).
 *
 * Enforcement is opt-in: a route with no decorator is not gated by CASL at all.
 * That is a real footgun on a financial endpoint — every controller that reads
 * or writes a document must carry it.
 *
 * Example: CheckAbility({ action: 'annul', subject: 'Factura' })
 */
export const CheckAbility = (...rules: RequiredRule[]) =>
  SetMetadata(CHECK_ABILITY_KEY, rules);

/** Metadata key marking a route (or controller) as intentionally unauthenticated. */
export const PUBLIC_KEY = 'route_public';

/**
 * Declares a route that anyone may call without credentials (health probes).
 * An explicit declaration, so "forgot to protect it" and "meant to be open"
 * can be told apart by the route-policy inventory test.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Metadata key holding the product module a route (or controller) belongs to. */
export const MODULO_KEY = 'route_modulo';

/**
 * Declares which contracted product module a route belongs to. `PoliciesGuard`
 * answers 403 when the active coproperty has not contracted it, even if the
 * caller holds the permission: the licence is a commercial entitlement checked
 * on top of permissions, never instead of them. Every route under
 * `PoliciesGuard` must declare one; the route-policy inventory test enforces it.
 */
export const Modulo = (modulo: ModuloProducto) =>
  SetMetadata(MODULO_KEY, modulo);

/** Metadata key marking a route that needs a signed-in caller but no permission. */
export const AUTHENTICATED_ONLY_KEY = 'route_authenticated_only';

/**
 * Declares a route that any signed-in caller may use, with no CASL permission
 * (the caller's own profile, public catalogs). Must be paired with
 * `FirebaseAuthGuard`; the inventory test enforces it.
 */
export const AuthenticatedOnly = () =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);

/** Metadata key holding the any-of ability rules a handler accepts. */
export const CHECK_ANY_ABILITY_KEY = 'check_any_ability';

/**
 * Declares abilities of which the caller needs AT LEAST ONE (logical OR).
 *
 * For read-only "consumer" routes shared by several flows (e.g. the Saldos
 * Iniciales a Recibo, a Nota Crédito or a Nota Anticipo may apply against):
 * any user who can perform one of those writes must be able to list the
 * candidates, without holding the unrelated admin permission.
 *
 * Independent from `CheckAbility`, which keeps its AND semantics untouched:
 * when a handler carries both, the caller must satisfy every `CheckAbility`
 * rule AND at least one `CheckAnyAbility` rule. An empty list gates nothing.
 *
 * Example: CheckAnyAbility(
 *   { action: 'create', subject: 'Recibo' },
 *   { action: 'create', subject: 'NotaCredito' },
 * )
 */
export const CheckAnyAbility = (...rules: RequiredRule[]) =>
  SetMetadata(CHECK_ANY_ABILITY_KEY, rules);
