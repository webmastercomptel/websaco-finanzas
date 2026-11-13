// src/modules/casl/casl-ability.constants.ts
//
// The authorization vocabulary. Actions are the verbs a caller can perform;
// subjects are the financial documents they act on. Kept as const tuples so the
// runtime maps and the compile-time unions derive from one source.
import { createMongoAbility } from '@casl/ability';
import type { MongoAbility, RawRuleOf } from '@casl/ability';

/**
 * There is deliberately NO `delete` action.
 *
 * No financial document is ever physically removed in this system. Voiding an
 * invoice is a state transition (estado: 'anulada') plus an append-only audit
 * entry — the history has to survive, because a ledger you can quietly erase is
 * not a ledger. Leaving `delete` out of the vocabulary means no route can even
 * ask for the permission, and no generated code can claim it was authorized.
 *
 * `annul` is the sanctioned replacement, and it is intentionally separate from
 * `update`: voiding is the most consequential act in the domain and deserves a
 * permission a role can be granted or denied on its own.
 */
export const ACTIONS = [
  'manage', // CASL alias: any action on the subject
  'read',
  'create',
  'update',
  'annul',
  'approve',
  'export',
  // Physically removing a NON-financial record (an announcement, a task, a
  // document of the building-management side). Only the Administración
  // permission keys can produce it (`eliminar`), and no financial subject can
  // ever receive it — `permission-map.ts` drops it there. It is not `delete`
  // on purpose: the audit law's "there is no delete action" stays literally true.
  'remove',
  // The guarded hard delete of data that is NOT yet a document: a charge
  // concept nobody used, a unit with no Factura, a lote cancelled before it
  // issued anything. Only the Finanzas verb `depurar` produces it, and the
  // services behind those routes refuse anything already issued. It is NOT
  // `remove`: that stays vetoed on every financial subject (the audit law), and
  // holding `purge` never implies it. Named apart from `delete` for the same
  // reason `remove` is.
  'purge',
  // Deliberately NOT `delete` — see the note above. The cycle reset that
  // physically deletes documents is NOT a CASL action at all: it sits behind
  // `PlatformAdminGuard` (see `ReiniciarCicloController`), so no role a
  // customer could be granted can reach it.
] as const;
export type Action = (typeof ACTIONS)[number];

export const SUBJECTS = [
  // Catalog: who maintains the register the financial documents point at.
  // Distinct from reading reports on purpose — the person who reads the
  // arrears report is usually not the one who may rewrite a unit's ownership.
  'Inmueble',
  'Tercero',
  'ConceptoCobro',
  // Financial documents.
  'Factura',
  'Recibo',
  'NotaCredito',
  'NotaContable',
  'OtraNota',
  'NotaAnticipo',
  // Opening cartera balances imported from a client's previous system — a
  // THIRD cartera charge document (see `SaldoInicial`'s own schema
  // docblock), kept as its own subject rather than folded into `Factura` so
  // a role can be granted "import Saldos Iniciales" without also gaining
  // any power over real Facturas.
  'SaldoInicial',
  // Opening ANTICIPO (credit) balances imported the same way — its own
  // subject rather than folded into `SaldoInicial` (a different action
  // grants importing cargos vs. importing anticipos) or `NotaAnticipo` (a
  // role that can create a Nota de Anticipo against real cartera should not
  // automatically be able to import historical opening credit balances).
  'SaldoInicialAnticipo',
  'Anulacion',
  'Consulta',
  'Configuracion',
  // "Interfaz a Comptable": its own subject, not `Configuracion` — whoever
  // exports the CSV is not automatically allowed to push asientos into
  // another company's books, nor to withdraw them (`annul` = retirar).
  'InterfazComptable',
  // Building-management (Administración) subjects. Unlike the financial ones,
  // these records may be physically removed (`remove`).
  'Dashboard',
  'Anuncio',
  'Usuario',
  'Pqr',
  'Reserva',
  'Documento',
  'Config',
  'Rol',
  'Tarea',
  'Mantenimiento',
  'Actividad',
  'Zona',
  'Tecnico',
  'all', // CASL alias: every subject
] as const;
export type Subject = (typeof SUBJECTS)[number];

/** The application ability: which (action, subject) pairs the caller may perform. */
export type AppAbility = MongoAbility<[Action, Subject]>;
export type AppRule = RawRuleOf<AppAbility>;

/** Rebuilds an ability from a plain rule array (server-computed, or shipped to a client). */
export const createAppAbility = (rules: AppRule[]): AppAbility =>
  createMongoAbility<AppAbility>(rules);
