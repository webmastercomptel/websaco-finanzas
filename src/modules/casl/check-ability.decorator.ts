// src/modules/casl/check-ability.decorator.ts
import { SetMetadata } from '@nestjs/common';
import type { Action, Subject } from './casl-ability.constants';

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
