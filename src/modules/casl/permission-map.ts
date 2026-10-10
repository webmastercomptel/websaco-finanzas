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

/**
 * `modulo` segment of a permission key -> CASL subject, or a list of subjects
 * when one catalog row deliberately governs several (every verb granted on the
 * key applies to each subject in the list).
 */
export const MODULE_TO_SUBJECT = {
  inmuebles: 'Inmueble',
  terceros: 'Tercero',
  conceptos: 'ConceptoCobro',
  facturas: 'Factura',
  recibos: 'Recibo',
  'notas-credito': 'NotaCredito',
  'notas-contables': 'NotaContable',
  'otras-notas': 'OtraNota',
  'notas-anticipo': 'NotaAnticipo',
  // One catalog row ("Saldos Iniciales (cartera y anticipos)") governs both
  // opening-balance documents with the same verbs.
  'saldos-iniciales': ['SaldoInicial', 'SaldoInicialAnticipo'],
  // Legacy key: no longer offered in the UI catalog, but roles saved earlier may
  // still store it. Keep it working (anticipo only, never SaldoInicial).
  'saldos-iniciales-anticipo': 'SaldoInicialAnticipo',
  anulaciones: 'Anulacion',
  consultas: 'Consulta',
  'cuentas-contables': 'Configuracion',
  'parametros-facturacion': 'Configuracion',
  documentos: 'Configuracion',
  'adicion-contabilidad': 'Configuracion',
  'ciclo-facturacion-prueba': 'CicloFacturacionPrueba',
} satisfies Record<string, Subject | readonly Subject[]>;

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
  reiniciar: 'reiniciar',
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
    const mapped = MODULE_TO_SUBJECT[
      modulo as keyof typeof MODULE_TO_SUBJECT
    ] as Subject | readonly Subject[] | undefined;
    const action = VERB_TO_ACTION[verbo as keyof typeof VERB_TO_ACTION];
    if (!mapped || !action) continue;
    const subjects = typeof mapped === 'string' ? [mapped] : mapped;
    for (const subject of subjects) can(action, subject);
  }

  return rules;
}
