import { escapeHtml, formatFecha } from './texto-correo';

describe('escapeHtml', () => {
  it('escapa los cuatro caracteres con significado en HTML', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;',
    );
  });

  it('deja intacto el texto sin caracteres especiales', () => {
    expect(escapeHtml('Reunión de asamblea')).toBe('Reunión de asamblea');
  });
});

describe('formatFecha', () => {
  it('muestra la hora de Colombia (UTC-5), no la del servidor', () => {
    const texto = formatFecha(new Date('2026-03-04T01:30:00Z'));

    // 01:30 UTC is 20:30 of the PREVIOUS day in Bogotá. The exact wording
    // depends on the ICU version, so only day, year and hour are pinned.
    expect(texto).toMatch(/\b3\b/);
    expect(texto).toContain('2026');
    expect(texto).toMatch(/8:30/);
    expect(texto).not.toMatch(/\b1:30\b/);
  });
});
