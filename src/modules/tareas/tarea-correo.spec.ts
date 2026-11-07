import { construirCorreoTareaAsignada } from './tarea-correo';

const base = {
  nombreAsignado: 'Juan',
  nombreCopropiedad: 'Torres del Parque',
  titulo: 'Limpiar zona común',
  categoria: 'limpieza',
  prioridad: 'alta',
  enlace: null,
};

describe('construirCorreoTareaAsignada', () => {
  it('arma el asunto con la copropiedad y el título', () => {
    expect(construirCorreoTareaAsignada(base).asunto).toBe(
      'Te asignaron una tarea en Torres del Parque: Limpiar zona común',
    );
  });

  it('incluye categoría y prioridad, y omite fecha y descripción cuando no hay', () => {
    const { html } = construirCorreoTareaAsignada(base);

    expect(html).toContain('limpieza');
    expect(html).toContain('alta');
    expect(html).not.toContain('Fecha límite');
    expect(html).not.toContain('Descripción');
  });

  it('incluye fecha límite y descripción cuando existen', () => {
    const { html } = construirCorreoTareaAsignada({
      ...base,
      descripcion: 'Trapear el lobby',
      fechaLimite: new Date('2026-03-04T15:00:00Z'),
    });

    expect(html).toContain('Fecha límite');
    expect(html).toContain('Trapear el lobby');
  });

  it('muestra el botón solo cuando hay enlace', () => {
    expect(construirCorreoTareaAsignada(base).html).not.toContain(
      'Ver mi tarea',
    );
    expect(
      construirCorreoTareaAsignada({ ...base, enlace: 'https://app.test/x' })
        .html,
    ).toContain('Ver mi tarea');
  });

  it('escapa el HTML que escribió el usuario (título, descripción, nombres)', () => {
    const { html } = construirCorreoTareaAsignada({
      ...base,
      titulo: '<script>alert(1)</script>',
      descripcion: '<img src=x onerror=alert(1)>',
      nombreAsignado: '<b>Juan</b>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Juan</b>');
    expect(html).toContain('&lt;script&gt;');
  });
});
