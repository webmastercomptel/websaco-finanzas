import { construirCorreoInvitacion } from './invitacion-correo';

const base = {
  nombre: 'Ana Pérez',
  nombreCopropiedad: 'Edificio Central',
  tipo: 'residente' as const,
  cuentaExistente: false,
  enlace: 'https://app.co/auth/enlace?token=abc',
};

describe('construirCorreoInvitacion', () => {
  it('lleva el botón con el enlace y nunca una caja de credenciales', () => {
    const { asunto, html } = construirCorreoInvitacion(base);

    expect(asunto).toContain('Edificio Central');
    expect(html).toContain('href="https://app.co/auth/enlace?token=abc"');
    expect(html).toContain('Entrar a WebSaco');
    expect(html).not.toMatch(/Usuario:|Contraseña:/);
  });

  it('sin enlace no hay botón y explica cómo entrar con la opción de olvido de contraseña', () => {
    const { html } = construirCorreoInvitacion({ ...base, enlace: null });

    expect(html).not.toContain('<a href');
    expect(html).toContain('Olvidé mi contraseña');
  });

  it('escapa el nombre y la copropiedad', () => {
    const { html } = construirCorreoInvitacion({
      ...base,
      nombre: '<script>alert(1)</script>',
      nombreCopropiedad: 'A & "B"',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; &quot;B&quot;');
  });

  it('distingue residente de personal y avisa si la cuenta ya existía', () => {
    expect(construirCorreoInvitacion(base).html).toContain(
      'información de tu inmueble',
    );
    const personal = construirCorreoInvitacion({
      ...base,
      tipo: 'personal',
      cuentaExistente: true,
    });
    expect(personal.html).toContain('equipo de la copropiedad');
    expect(personal.html).toContain('contraseña de siempre');
  });
});
