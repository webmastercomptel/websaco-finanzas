import { construirCorreoMantenimientoAsignado } from './mantenimiento-correo';

const base = {
  nombreTecnico: 'Elevadores S.A.',
  nombreCopropiedad: 'Torres del Parque',
  titulo: 'Revisión de ascensores',
  tipo: 'preventivo',
  fecha: new Date('2026-09-10T13:00:00Z'),
  horario: null,
  ubicacion: '',
};

describe('construirCorreoMantenimientoAsignado', () => {
  it('arma el asunto con la copropiedad y el título', () => {
    expect(construirCorreoMantenimientoAsignado(base).asunto).toBe(
      'Mantenimiento asignado en Torres del Parque: Revisión de ascensores',
    );
  });

  it('nombra el tipo de mantenimiento y no lleva botón (es un correo plano)', () => {
    const { html } = construirCorreoMantenimientoAsignado(base);

    expect(html).toContain('Mantenimiento preventivo');
    expect(html).not.toContain('<a href');
  });

  it('incluye horario, ubicación y detalle solo cuando existen', () => {
    const sin = construirCorreoMantenimientoAsignado(base).html;
    expect(sin).not.toContain('Detalle');
    expect(sin).not.toContain(', en ');

    const con = construirCorreoMantenimientoAsignado({
      ...base,
      horario: '08:00 - 10:00',
      ubicacion: 'Torre B',
      descripcion: 'Revisar cables',
    }).html;
    expect(con).toContain('08:00 - 10:00');
    expect(con).toContain(', en Torre B');
    expect(con).toContain('Revisar cables');
  });

  it('escapa el HTML que escribió el usuario', () => {
    const { html } = construirCorreoMantenimientoAsignado({
      ...base,
      titulo: '<script>alert(1)</script>',
      descripcion: '<img src=x onerror=alert(1)>',
      nombreTecnico: '<b>Ana</b>',
      ubicacion: '<i>Lobby</i>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Ana</b>');
    expect(html).not.toContain('<i>Lobby</i>');
    expect(html).toContain('&lt;script&gt;');
  });
});
