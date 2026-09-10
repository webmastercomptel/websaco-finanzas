import { BadRequestException } from '@nestjs/common';

/**
 * The `{year, month}` of a bare calendar date (`fechaRecibo`, a Nota
 * Crédito's `fecha`, `LoteFacturacion.billingDate`) — all always a plain
 * "YYYY-MM-DD" parsed as UTC midnight, never a real wall-clock timestamp.
 * Deliberately reads UTC, NOT `periodoDe()`'s local-time reading
 * (`periodo.service.ts`): `periodoDe` exists for a genuine local timestamp
 * close to midnight, but applying it to a UTC-midnight calendar date on a
 * host running a negative UTC offset (Colombia, UTC-5 — this backend's own
 * users) rolls day 1 of the month back into the previous month entirely,
 * which is exactly the bug a user hit in production comparing a lote
 * `billingDate` of "2026-08-01" against a Recibo dated "2026-08-31" — both
 * clearly August, but `periodoDe` read the lote as July.
 *
 * Extracted out of `RecibosService` (its original home) so
 * `NotasCreditoService.crear()` can validate a Nota Crédito's own `fecha`
 * against the current billing period exactly the same way a Recibo's
 * `fechaRecibo` already is — same rule, same bug class, one definition.
 */
export const periodoCalendarioDe = (
  fecha: Date,
): { year: number; month: number } => ({
  year: fecha.getUTCFullYear(),
  month: fecha.getUTCMonth() + 1,
});

/**
 * The one check every document-dating call site in this backend needs
 * before trusting a caller-supplied business date: it must fall in the same
 * month/year as the coproperty's last consolidated billing run. Shared so
 * the rule — and its exact wording — can never drift between a document's
 * own creation (`fechaRecibo`, a Nota Crédito's `fecha`, …) and its
 * anulación (which now takes its own `fecha` too, for the same reason: the
 * reversing asiento must be dated by the user, never by the server clock).
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
  ultimoLote: { billingDate: Date } | null,
  etiqueta: string,
): void {
  if (!ultimoLote) return;
  const periodoLote = periodoCalendarioDe(ultimoLote.billingDate);
  const periodoFecha = periodoCalendarioDe(fecha);
  if (
    periodoLote.year !== periodoFecha.year ||
    periodoLote.month !== periodoFecha.month
  ) {
    throw new BadRequestException(
      `${etiqueta} debe corresponder al período de facturación actual ` +
        `(${String(periodoLote.month).padStart(2, '0')}/${periodoLote.year})`,
    );
  }
}
