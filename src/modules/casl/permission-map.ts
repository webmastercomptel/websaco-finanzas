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
  inmuebles: 'Inmueble',
  terceros: 'Tercero',
  conceptos: 'ConceptoCobro',
  facturas: 'Factura',
  recibos: 'Recibo',
  'notas-credito': 'NotaCredito',
  'notas-contables': 'NotaContable',
  'otras-notas': 'OtraNota',
  'notas-anticipo': 'NotaAnticipo',
  // Opening balances of cartera and of anticipo are separate catalog rows with
  // separate permissions: `saldos-iniciales.*` never grants SaldoInicialAnticipo.
  'saldos-iniciales': 'SaldoInicial',
  'saldos-iniciales-anticipo': 'SaldoInicialAnticipo',
  anulaciones: 'Anulacion',
  consultas: 'Consulta',
  'cuentas-contables': 'Configuracion',
  'parametros-facturacion': 'Configuracion',
  documentos: 'Configuracion',
  'adicion-contabilidad': 'Configuracion',
  // ver = read (estado, pendientes, historial), crear = create (simular,
  // enviar, reintentar), anular = annul (retirar un lote de Comptable).
  'interfaz-comptable': 'InterfazComptable',
} satisfies Record<string, Subject>;

/**
 * Building-management (Administración) `modulo` segments -> CASL subject.
 * Kept apart from the financial map so a segment's module is never ambiguous:
 * `documentos` stays Finanzas (it maps to `Configuracion`), and the building
 * management one is `documentos-administracion`.
 */
export const MODULE_TO_SUBJECT_ADMINISTRACION = {
  dashboard: 'Dashboard',
  anuncios: 'Anuncio',
  usuarios: 'Usuario',
  pqr: 'Pqr',
  reservas: 'Reserva',
  'documentos-administracion': 'Documento',
  config: 'Config',
  roles: 'Rol',
  tareas: 'Tarea',
  mantenimientos: 'Mantenimiento',
  actividades: 'Actividad',
  zonas: 'Zona',
  tecnicos: 'Tecnico',
} satisfies Record<string, Subject>;

/**
 * Verbs only the Administración keys understand, on top of `VERB_TO_ACTION`.
 * `eliminar` -> `remove` is the one the financial side must never have.
 * `gestionar` -> `manage` lives here too: in Administración one key covering a
 * whole subject is the established vocabulary (`pqr.gestionar`), while in
 * Finanzas it was retired so every permission is an exact, delegable key.
 */
export const VERB_TO_ACTION_ADMINISTRACION = {
  subir: 'create',
  actualizar: 'update',
  eliminar: 'remove',
  gestionar: 'manage',
} satisfies Record<string, Action>;

/**
 * `accion` segment of a permission key -> CASL action.
 *
 * There is no `eliminar` verb here, and adding one would be a bug: see the note
 * on ACTIONS in casl-ability.constants.ts. `anular` is how a document is
 * retired. `eliminar` exists only in `VERB_TO_ACTION_ADMINISTRACION`, and
 * `remove` stays vetoed on every financial subject.
 *
 * There is no `gestionar` verb either: a Finanzas key that stood for "every
 * action" could not be held, given or taken away one action at a time. A stored
 * `facturas.gestionar` is therefore an unknown key, which means DENY.
 * `depurar` -> `purge` is the guarded hard delete of pre-document data (a
 * charge concept, a unit with no Factura, a lote before it issues anything);
 * it is deliberately not `remove`, so the veto above does not apply to it and
 * does not need to be lifted.
 */
export const VERB_TO_ACTION = {
  ver: 'read',
  crear: 'create',
  editar: 'update',
  anular: 'annul',
  aprobar: 'approve',
  exportar: 'export',
  depurar: 'purge',
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
  const { can, cannot, rules } = new AbilityBuilder<AppAbility>(
    createMongoAbility,
  );
  // CASL's `manage` covers every action, `remove` included. Nothing financial is
  // ever physically removed, so `remove` is vetoed on every financial subject
  // AFTER the grants (later rules win) — for platform admins too.
  const vetarRemoveFinanciero = (): void => {
    cannot('remove', Object.values(MODULE_TO_SUBJECT) as Subject[]);
  };

  if (opts.platformAdmin) {
    can('manage', 'all');
    vetarRemoveFinanciero();
    return rules;
  }

  for (const key of keys) {
    const [modulo, verbo] = key.split('.');
    const financiero = MODULE_TO_SUBJECT[
      modulo as keyof typeof MODULE_TO_SUBJECT
    ] as Subject | undefined;
    const administracion = MODULE_TO_SUBJECT_ADMINISTRACION[
      modulo as keyof typeof MODULE_TO_SUBJECT_ADMINISTRACION
    ] as Subject | undefined;
    const subject = financiero ?? administracion;
    // Only the building-management side knows `subir`/`actualizar`/`eliminar`.
    // A financial key with such a verb is simply unknown, which means DENY.
    const action = financiero
      ? VERB_TO_ACTION[verbo as keyof typeof VERB_TO_ACTION]
      : (VERB_TO_ACTION_ADMINISTRACION[
          verbo as keyof typeof VERB_TO_ACTION_ADMINISTRACION
        ] ?? VERB_TO_ACTION[verbo as keyof typeof VERB_TO_ACTION]);
    if (!subject || !action) continue;
    can(action, subject);
  }

  // Only when something was granted: an empty key list must stay an empty rule set.
  if (rules.length > 0) vetarRemoveFinanciero();
  return rules;
}
