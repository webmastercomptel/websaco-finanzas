// src/common/publico/piso-de-tiempo.ts

/**
 * Waits until `ms` have passed since `inicioMs` (a `Date.now()` taken when the
 * request started). Called before every refusal so the time to answer does not
 * reveal which check refused it. Returns at once when the floor already passed.
 */
export async function esperarPisoDeTiempo(
  inicioMs: number,
  ms: number,
): Promise<void> {
  const restante = ms - (Date.now() - inicioMs);
  if (restante <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, restante));
}
