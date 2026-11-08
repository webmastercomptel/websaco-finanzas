// src/common/firebase/codigos-cuenta.ts

/**
 * Stable machine code in the body of the 409 that `/equipo` and `/residentes`
 * answer when the e-mail already belongs to a local account and the caller did
 * not confirm the link with `vincularExistente`. Same `{ code, message }` shape
 * as the other coded errors (`SISTEMA_NO_SOPORTADO`, `VINCULO_EXISTENTE`…):
 * clients branch on `code`, never on the Spanish `message`, which may be reworded.
 */
export const CODIGO_CUENTA_EXISTENTE = 'CUENTA_EXISTENTE';
