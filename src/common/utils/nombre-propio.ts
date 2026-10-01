// src/common/utils/nombre-propio.ts

/** Abbreviations kept as written here when a name is stored as "Nombre
 *  Propio" (compared upper-cased, without dots): company types, tax and
 *  accounting acronyms common in PUC account names, banks, and Roman
 *  numerals for towers/stages. Mixed-case ones (CxC) map to their form. */
const SIGLAS_MIXTAS = new Map([
  ['CXC', 'CxC'],
  ['CXP', 'CxP'],
]);
const SIGLAS = new Set([
  'CXC',
  'CXP',
  'BRC',
  'BBVA',
  'DB',
  'CR',
  'SAS',
  'SA',
  'LTDA',
  'EU',
  'SCA',
  'SCS',
  'ESP',
  'EICE',
  'IPS',
  'EPS',
  'NIT',
  'CI',
  'CIA',
  'PH',
  'ESAL',
  'ONG',
  'BIC',
  'IVA',
  'ICA',
  'DIAN',
  'GMF',
  'NIIF',
  'PUC',
  'II',
  'III',
  'IV',
]);

/** Connectors written in lower case unless they open the name ("Recibo de
 *  Caja", "Intereses por Mora"). Single letters (a, e, o, u) are left out on
 *  purpose: in a person's name they are usually an initial ("Juan E. Perez"). */
const CONECTORES = new Set([
  'de',
  'del',
  'y',
  'en',
  'por',
  'para',
  'con',
  'al',
]);

/** Articles stay capitalized as part of a proper name ("Conjunto El Roble",
 *  "Edificio Los Pinos") but go lower case right after "de" — "Maria de la
 *  Torre", "Banco de los Andes". */
const ARTICULOS = new Set(['el', 'la', 'los', 'las']);

/**
 * Each word capitalized, the rest in lower case — "EDIFICIO LOS PINOS P.H."
 * → "Edificio Los Pinos P.H." — keeping the abbreviations above as written
 * and the connectors in lower case. The owner's rule (2026-10-01): names are
 * stored this way however they were typed or imported from Excel.
 */
export function nombrePropio(nombre: string): string {
  let anterior: string | null = null;
  return nombre
    .toLocaleLowerCase('es-CO')
    .replace(/[\p{L}\p{N}.&]+/gu, (palabra) => {
      const previa = anterior;
      anterior = palabra;
      const clave = palabra.replace(/\./g, '').toUpperCase();
      if (SIGLAS.has(clave)) {
        return SIGLAS_MIXTAS.get(clave) ?? palabra.toLocaleUpperCase('es-CO');
      }
      if (previa !== null) {
        if (CONECTORES.has(palabra)) return palabra;
        if (ARTICULOS.has(palabra) && (previa === 'de' || previa === 'del')) {
          return palabra;
        }
      }
      return palabra.charAt(0).toLocaleUpperCase('es-CO') + palabra.slice(1);
    });
}

/**
 * `nombrePropio` as a Mongoose `set:` option. A setter, not a service call,
 * so every write path — create, insertMany, $set, bulkWrite — and every
 * equality filter on the field is normalized without each caller
 * remembering to. Non-strings (null, a RegExp filter) pass through.
 */
export const comoNombrePropio = <T>(valor: T): T =>
  (typeof valor === 'string' ? nombrePropio(valor) : valor) as T;
