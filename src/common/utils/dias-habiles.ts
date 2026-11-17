// src/common/utils/dias-habiles.ts
//
// Colombian business-day calendar, computed for any year (no year table to
// maintain). Dates are UTC-midnight values representing a calendar day.
import { DESFASE_BOGOTA_MS } from './reloj-bogota';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Legal term to answer a PQR, in business days; the base of the suggested deadline. */
export const DIAS_HABILES_RESPUESTA_PQR = 15;

const clave = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (anio: number, mes: number, dia: number): Date =>
  new Date(Date.UTC(anio, mes - 1, dia));
const masDias = (d: Date, n: number): Date =>
  new Date(d.getTime() + n * MS_POR_DIA);

/** Easter Sunday by the anonymous Gregorian computus (the holidays hang off it). */
const domingoDePascua = (anio: number): Date => {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(anio, mes, dia);
};

/** Ley 51 de 1983 (Emiliani): moves to the next Monday unless already Monday. */
const aLunes = (d: Date): Date => {
  const dow = d.getUTCDay();
  return dow === 1 ? d : masDias(d, (8 - dow) % 7);
};

const cacheFestivos = new Map<number, string[]>();

/**
 * Colombian public holidays of a year as sorted, distinct `YYYY-MM-DD`.
 * Computed, not tabulated, so any year works; distinct because two holidays
 * can land on the same day.
 */
export const festivosColombia = (anio: number): string[] => {
  const cacheado = cacheFestivos.get(anio);
  if (cacheado) return cacheado;
  const fijos = [
    [1, 1],
    [5, 1],
    [7, 20],
    [8, 7],
    [12, 8],
    [12, 25],
  ].map(([m, d]) => utc(anio, m, d));
  const emiliani = [
    [1, 6],
    [3, 19],
    [6, 29],
    [8, 15],
    [10, 12],
    [11, 1],
    [11, 11],
  ].map(([m, d]) => aLunes(utc(anio, m, d)));
  const pascua = domingoDePascua(anio);
  // E+43/E+64/E+71 are the already-moved Mondays of Ascension, Corpus Christi
  // and Sagrado Corazón; E-3/E-2 are Jueves/Viernes Santo.
  const deLaPascua = [-3, -2, 43, 64, 71].map((n) => masDias(pascua, n));
  const todos = [...fijos, ...emiliani, ...deLaPascua].map(clave);
  const resultado = [...new Set(todos)].sort();
  cacheFestivos.set(anio, resultado);
  return resultado;
};

/** True when the UTC-midnight business date is neither a weekend nor a holiday. */
export const esDiaHabil = (fecha: Date): boolean => {
  const dow = fecha.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !festivosColombia(fecha.getUTCFullYear()).includes(clave(fecha));
};

/** The n-th business day AFTER `fecha` (day 0 is never counted), UTC midnight. */
export const sumarDiasHabiles = (fecha: Date, n: number): Date => {
  let actual = new Date(fecha.getTime() - (fecha.getTime() % MS_POR_DIA));
  let restantes = n;
  while (restantes > 0) {
    actual = masDias(actual, 1);
    if (esDiaHabil(actual)) restantes -= 1;
  }
  return actual;
};

/**
 * The Bogotá calendar day of a real instant, as UTC midnight: a PQR filed at
 * 23:30 Bogotá is still that day although its UTC date is already the next.
 */
export const diaBogota = (instante: Date): Date => {
  const pared = instante.getTime() - DESFASE_BOGOTA_MS;
  return new Date(pared - (((pared % MS_POR_DIA) + MS_POR_DIA) % MS_POR_DIA));
};

/** Suggested response deadline: 15 business days after the Bogotá filing day. */
export const fechaLimiteSugerida = (radicadaEn: Date): Date =>
  sumarDiasHabiles(diaBogota(radicadaEn), DIAS_HABILES_RESPUESTA_PQR);
