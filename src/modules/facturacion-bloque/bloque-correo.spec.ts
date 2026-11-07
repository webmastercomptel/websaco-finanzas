import { construirAsuntoBloque, construirCorreoBloque } from './bloque-correo';

const datos = {
  nombreDestinatario: 'Rosa',
  nombreCopropiedad: 'Torres del Parque',
  tipo: 'factura',
  periodo: '2026-07',
  codigoInmueble: '301',
  enlace: 'https://app.test/auth/enlace?token=abc',
};

describe('construirCorreoBloque', () => {
  it('el asunto nombra el tipo y el período; el estado de cuenta se escribe con espacios', () => {
    expect(construirAsuntoBloque('factura', '2026-07')).toBe(
      'Tu factura de 2026-07 ya está disponible',
    );
    expect(construirAsuntoBloque('estado_cuenta', '2026-07')).toBe(
      'Tu estado de cuenta de 2026-07 ya está disponible',
    );
  });

  it('dice el inmueble, no adjunta el PDF y lleva el botón al enlace', () => {
    const { asunto, html } = construirCorreoBloque(datos);

    expect(asunto).toBe('Tu factura de 2026-07 ya está disponible');
    expect(html).toContain('Inmueble: <strong>301</strong>');
    expect(html).toContain('Por seguridad no lo adjuntamos');
    expect(html).toContain('https://app.test/auth/enlace?token=abc');
  });

  it('sin enlace (no se puede emitir uno) no pinta botón', () => {
    const { html } = construirCorreoBloque({ ...datos, enlace: null });

    expect(html).not.toContain('Ver mi documento');
  });

  it('escapa todo lo que no es nuestro: nombre, copropiedad, período y código de inmueble', () => {
    const { html } = construirCorreoBloque({
      ...datos,
      nombreDestinatario: '<img src=x onerror=1>',
      nombreCopropiedad: 'A&B "S.A."',
      periodo: '<script>alert(1)</script>',
      codigoInmueble: '<b>301</b>',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>301</b>');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).toContain('A&amp;B &quot;S.A.&quot;');
    expect(html).toContain('&lt;b&gt;301&lt;/b&gt;');
  });
});
