import { construirCorreoIngreso } from './correo-ingreso';
import { VIGENCIA_ENLACE_INGRESO_MS } from './ingreso-portal.constantes';
import { construirEnlaceIngreso } from './enlace-ingreso.service';

const TOKEN = 'ab'.repeat(32);
const ENLACE = construirEnlaceIngreso('https://app.ejemplo.com', TOKEN);

describe('construirCorreoIngreso', () => {
  it('SEC: sign-in mail carries only the fragment link', () => {
    const { asunto, html } = construirCorreoIngreso({ enlace: ENLACE });

    expect(asunto).toBe('Tu enlace para entrar a WebSaco');
    // `/ingreso#` + 64 hex, exactly once (the button), nowhere else.
    const apariciones = html.split(`/ingreso#${TOKEN}`).length - 1;
    expect(apariciones).toBe(1);
    expect(html.split(TOKEN).length - 1).toBe(1);
    expect(html).toContain('Entrar a mi portal');
    // Never a session link, never the token in a query.
    expect(html).not.toContain('/auth/enlace');
    expect(html).not.toContain('token=');
    expect(html).not.toContain('?');
  });

  it('says the link works once and for how long, derived from the constant', () => {
    const { html } = construirCorreoIngreso({ enlace: ENLACE });

    expect(VIGENCIA_ENLACE_INGRESO_MS).toBe(15 * 60 * 1000);
    expect(html).toContain(
      'Este enlace sirve una sola vez y vence en 15 minutos.',
    );
    expect(html).toContain('Si no fuiste tú, puedes ignorar este mensaje');
  });

  it('follows the constant when the lifetime changes', () => {
    const { html } = construirCorreoIngreso({
      enlace: ENLACE,
      vigenciaMs: 60 * 60 * 1000,
    });

    expect(html).toContain('vence en 60 minutos.');
    expect(html).not.toContain('15 minutos');
  });

  it('names no amount, unit, invoice or person, and speaks in tuteo', () => {
    const { html } = construirCorreoIngreso({ enlace: ENLACE });
    const texto = html.replace(/<[^>]+>/g, ' ');

    expect(texto).not.toMatch(/\$|inmueble|apartamento|factura|saldo|monto/i);
    expect(texto).not.toMatch(/\b(tenés|querés|podés|sos|vos)\b/i);
    expect(texto).toMatch(/\btu\b/i);
  });

  it('escapes the link it is given instead of trusting it', () => {
    const { html } = construirCorreoIngreso({
      enlace: 'https://x.test/ingreso#a"><b>x</b>',
    });

    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('two links give two different bodies (the token is the only variable part)', () => {
    const a = construirCorreoIngreso({ enlace: ENLACE });
    const b = construirCorreoIngreso({
      enlace: construirEnlaceIngreso(
        'https://app.ejemplo.com',
        'cd'.repeat(32),
      ),
    });

    expect(a.html).not.toBe(b.html);
    expect(a.asunto).toBe(b.asunto);
  });
});
