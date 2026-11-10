import {
  construirCorreoReservaNueva,
  construirCorreoReservaRespuesta,
} from './reserva-correo';

const inicio = new Date('2026-09-01T14:00:00.000Z');
const fin = new Date('2026-09-01T16:00:00.000Z');

describe('construirCorreoReservaNueva', () => {
  const base = {
    nombreDestinatario: 'Admin',
    nombreCopropiedad: 'Torres del Parque',
    espacio: 'Salón Social',
    inicio,
    fin,
    residenteNombre: 'Juan Pérez',
    unidad: '501',
    motivo: 'Cumpleaños',
    enlace: 'https://app.example.com/auth/enlace?x=1',
  };

  it('el asunto nombra la copropiedad y el espacio', () => {
    expect(construirCorreoReservaNueva(base).asunto).toBe(
      'Nueva reserva pendiente en Torres del Parque: Salón Social',
    );
  });

  it('el cuerpo trae solicitante, unidad, motivo y el botón para aprobar o rechazar', () => {
    const { html } = construirCorreoReservaNueva(base);

    expect(html).toContain('Juan Pérez');
    expect(html).toContain('(unidad 501)');
    expect(html).toContain('Cumpleaños');
    expect(html).toContain('Aprobar o rechazar');
    expect(html).toContain('https://app.example.com/auth/enlace?x=1');
  });

  it('sin enlace no hay botón, y sin unidad ni motivo no se imprimen', () => {
    const { html } = construirCorreoReservaNueva({
      ...base,
      enlace: null,
      unidad: '',
      motivo: null,
    });

    expect(html).not.toContain('Aprobar o rechazar');
    expect(html).not.toContain('unidad');
    expect(html).not.toContain('Motivo');
  });

  it('escapa lo que escribió la persona', () => {
    const { html } = construirCorreoReservaNueva({
      ...base,
      residenteNombre: '<script>x</script>',
      motivo: '"><img src=x>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
  });
});

describe('construirCorreoReservaRespuesta', () => {
  const base = {
    nombreDestinatario: 'Juan',
    nombreCopropiedad: 'Torres del Parque',
    espacio: 'Salón Social',
    inicio,
    fin,
    enlace: 'https://app.example.com/auth/enlace?x=1',
  };

  it.each([
    ['aprobada', 'Tu reserva de Salón Social fue aprobada', 'Reserva aprobada'],
    [
      'rechazada',
      'Tu reserva de Salón Social fue rechazada',
      'Reserva rechazada',
    ],
    [
      'cancelada',
      'Tu reserva de Salón Social fue cancelada',
      'Reserva cancelada',
    ],
  ] as const)('%s: asunto y encabezado', (respuesta, asunto, encabezado) => {
    const resultado = construirCorreoReservaRespuesta({ ...base, respuesta });

    expect(resultado.asunto).toBe(asunto);
    expect(resultado.html).toContain(encabezado);
    expect(resultado.html).toContain('Ver mi reserva');
  });

  it('sin enlace no hay botón', () => {
    const { html } = construirCorreoReservaRespuesta({
      ...base,
      respuesta: 'aprobada',
      enlace: null,
    });

    expect(html).not.toContain('Ver mi reserva');
  });
});

describe('las horas del correo son las que escribió la persona', () => {
  // Stored as the Bogotá wall clock written as UTC: 21:00 typed is T21:00Z.
  const noche = {
    nombreDestinatario: 'Admin',
    nombreCopropiedad: 'Torres del Parque',
    espacio: 'Salón Social',
    inicio: new Date('2026-09-10T21:00:00.000Z'),
    fin: new Date('2026-09-10T23:00:00.000Z'),
    enlace: null,
  };

  it('una reserva de 21:00 a 23:00 se lee 9:00 y 11:00 p. m., no 4:00 y 6:00 (sin restar 5 horas)', () => {
    const { html } = construirCorreoReservaNueva({
      ...noche,
      residenteNombre: 'Juan',
      unidad: '501',
      motivo: null,
    });

    expect(html).toMatch(/9:00/);
    expect(html).toMatch(/11:00/);
    expect(html).not.toMatch(/\b4:00/);
    expect(html).not.toMatch(/\b6:00/);
    expect(html).toMatch(/\b10\b/);
  });

  it('también en la respuesta al residente', () => {
    const { html } = construirCorreoReservaRespuesta({
      ...noche,
      respuesta: 'aprobada',
    });

    expect(html).toMatch(/9:00/);
    expect(html).not.toMatch(/\b4:00/);
  });
});
