// src/modules/casl/permission-map.ts
//
// Translates the persisted permission catalog (`modulo.accion` keys stored on
// roles) into CASL rules. This is the ONLY place that mapping lives, so backend
// enforcement and any rule set shipped to the frontend can never drift apart.
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type {
  Action,
  AppAbility,
  AppRule,
  Subject,
} from './casl-ability.constants';

/** `modulo` segment of a permission key -> CASL subject. */
export const MODULE_TO_SUBJECT = {
  facturas: 'Factura',
  recibos: 'Recibo',
  'notas-credito': 'NotaCredito',
  'otras-notas': 'OtraNota',
  anulaciones: 'Anulacion',
  consultas: 'Consulta',
} satisfies Record<string, Subject>;

/**
 * `accion` segment of a permission key -> CASL action.
 *
 * There is no `eliminar` verb, and adding one would be a bug: see the note on
 * ACTIONS in casl-ability.constants.ts. `anular` is how a document is retired.
 */
export const VERB_TO_ACTION = {
  ver: 'read',
  crear: 'create',
  editar: 'update',
  anular: 'annul',
  aprobar: 'approve',
  exportar: 'export',
  gestionar: 'manage',
} satisfies Record<string, Action>;

/**
 * Builds CASL rules from a role's permission keys. Platform admins get
 * `manage all` and the keys are ignored. Unknown or malformed keys are skipped
 * defensively, so a stray catalog entry can never crash authorization — note
 * that skipping means DENY, never allow.
 */
export function rulesFromPermissionKeys(
  keys: string[],
  opts: { platformAdmin?: boolean } = {},
): AppRule[] {
  const { can, rules } = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (opts.platformAdmin) {
    can('manage', 'all');
    return rules;
  }

  for (const key of keys) {
    const [modulo, verbo] = key.split('.');
    const subject = MODULE_TO_SUBJECT[modulo as keyof typeof MODULE_TO_SUBJECT];
    const action = VERB_TO_ACTION[verbo as keyof typeof VERB_TO_ACTION];
    if (subject && action) can(action, subject);
  }

  return rules;
}
