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
