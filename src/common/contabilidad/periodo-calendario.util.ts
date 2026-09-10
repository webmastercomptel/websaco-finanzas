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
