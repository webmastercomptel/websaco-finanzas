import { construirCorreoActividadNueva } from './actividad-correo';

const base = {
  nombreResidente: 'Ana',
  nombreCopropiedad: 'Torres del Parque',
  titulo: 'Clase de yoga',
  categoria: 'salud',
  fecha: new Date('2026-09-10T13:00:00Z'),
  horario: '08:00 - 09:00',
  ubicacion: 'Salón comunal',
  enlace: null,
};

describe('construirCorreoActividadNueva', () => {
  it('arma el asunto con la copropiedad y el título', () => {
    expect(construirCorreoActividadNueva(base).asunto).toBe(
      'Nueva actividad en Torres del Parque: Clase de yoga',
    );
  });

  it('muestra el horario, y "Por confirmar" cuando no hay', () => {
    expect(construirCorreoActividadNueva(base).html).toContain('08:00 - 09:00');
    expect(
      construirCorreoActividadNueva({ ...base, horario: '' }).html,
    ).toContain('Por confirmar');
  });

  it('incluye ubicación y descripción solo cuando existen', () => {
    const sin = construirCorreoActividadNueva({ ...base, ubicacion: '' }).html;
    expect(sin).not.toContain('Ubicación');
    expect(sin).not.toContain('Descripción');

    const con = construirCorreoActividadNueva({
      ...base,
      descripcion: 'Trae tu tapete',
    }).html;
    expect(con).toContain('Salón comunal');
    expect(con).toContain('Trae tu tapete');
  });

  it('muestra el botón solo cuando hay enlace', () => {
    expect(construirCorreoActividadNueva(base).html).not.toContain(
      'Confirmar asistencia',
    );
    expect(
      construirCorreoActividadNueva({ ...base, enlace: 'https://app.test/x' })
        .html,
    ).toContain('Confirmar asistencia');
  });

  it('escapa el HTML que escribió el usuario', () => {
    const { html } = construirCorreoActividadNueva({
      ...base,
      titulo: '<script>alert(1)</script>',
      descripcion: '<img src=x onerror=alert(1)>',
      nombreResidente: '<b>Ana</b>',
      ubicacion: '<i>Salón</i>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Ana</b>');
    expect(html).not.toContain('<i>Salón</i>');
    expect(html).toContain('&lt;script&gt;');
  });
});
