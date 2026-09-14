import { BadRequestException } from '@nestjs/common';

/**
 * `dd/mm/aaaa` of a bare calendar date (`periodStart`/`periodEnd`, always a
 * plain "YYYY-MM-DD" parsed as UTC midnight) — reads UTC getters on purpose,
 * same reasoning as the rest of this file: a host running a negative UTC
 * offset (Colombia, UTC-5 — this backend's own users) would otherwise roll
 * day 1 of the month back into the previous day.
 */
const formatoFecha = (fecha: Date): string => {
  const dd = String(fecha.getUTCDate()).padStart(2, '0');
  const mm = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${fecha.getUTCFullYear()}`;
};

/**
 * The one check every document-dating call site in this backend needs
 * before trusting a caller-supplied business date: it must fall within the
 * coproperty's last consolidated billing run's own period
 * (`periodStart`–`periodEnd`, inclusive). Shared so the rule — and its exact
 * wording — can never drift between a document's own creation
 * (`fechaRecibo`, a Nota Crédito's `fecha`, …) and its anulación (which now
 * takes its own `fecha` too, for the same reason: the reversing asiento must
 * be dated by the user, never by the server clock).
 *
 * Compares the `Date` objects directly rather than year/month — every date
 * involved is a bare "YYYY-MM-DD" parsed as UTC midnight (never a real
 * wall-clock timestamp), so direct comparison is exact and already
 * inclusive of both endpoints without a separate day check.
 *
 * `ultimoLote` is `null` exactly when the coproperty has never consolidated
 * a lote — nothing to validate against yet, so this is a no-op, same
 * precedent every caller already established individually before this was
 * extracted.
 *
 * `etiqueta` names the field in the error message (e.g. "La fecha de la
 * nota", "La fecha de la anulación") — the check is identical either way,
 * only what the user needs to recognize differs.
 */
export function exigirPeriodoFacturacionActual(
  fecha: Date,
  ultimoLote: { periodStart: Date; periodEnd: Date } | null,
  etiqueta: string,
): void {
  if (!ultimoLote) return;
  if (fecha < ultimoLote.periodStart || fecha > ultimoLote.periodEnd) {
    throw new BadRequestException(
      `${etiqueta} debe estar dentro del período de facturación actual ` +
        `(${formatoFecha(ultimoLote.periodStart)} – ${formatoFecha(ultimoLote.periodEnd)})`,
    );
  }
}
