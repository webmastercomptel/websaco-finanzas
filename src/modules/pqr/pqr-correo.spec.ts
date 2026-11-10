import {
  construirCorreoPqrNueva,
  construirCorreoPqrRespuesta,
} from './pqr-correo';

const nueva = {
  nombreDestinatario: 'Admin',
  nombreCopropiedad: 'Torres del Parque',
  codigo: 'PQR-007',
  titulo: 'Filtración',
  tipo: 'reclamos',
  prioridad: 'alta',
  unidad: 'A-101',
  residenteNombre: 'Juan Pérez',
  descripcion: 'Hay una filtración',
  enlace: null,
};

describe('construirCorreoPqrNueva', () => {
  it('arma el asunto con la copropiedad y el código', () => {
    expect(construirCorreoPqrNueva(nueva).asunto).toBe(
      'Nueva PQR en Torres del Parque: PQR-007',
    );
  });

  it('traduce tipo y prioridad a su etiqueta legible', () => {
    const { html } = construirCorreoPqrNueva(nueva);

    expect(html).toContain('Reclamo');
    expect(html).toContain('Alta');
  });

  it('menciona unidad y residente solo cuando existen', () => {
    expect(construirCorreoPqrNueva(nueva).html).toContain('inmueble A-101');
    expect(construirCorreoPqrNueva(nueva).html).toContain(
      'a nombre de Juan Pérez',
    );

    const sin = construirCorreoPqrNueva({
      ...nueva,
      unidad: '',
      residenteNombre: '',
    }).html;
    expect(sin).not.toContain('inmueble ');
    expect(sin).not.toContain('a nombre de');
  });

  it('escapa todo lo que escribió una persona y conserva los saltos de línea', () => {
    const { html } = construirCorreoPqrNueva({
      ...nueva,
      titulo: '<script>x</script>',
      residenteNombre: '<b>Eva</b>',
      descripcion: 'línea 1\nlínea <i>2</i>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Eva</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('línea 1<br/>línea &lt;i&gt;2&lt;/i&gt;');
  });

  it('muestra el botón solo si hay enlace de acceso', () => {
    expect(construirCorreoPqrNueva(nueva).html).not.toContain('Ver la PQR');

    const con = construirCorreoPqrNueva({
      ...nueva,
      enlace: 'https://app.example.com/auth/enlace?token=abc',
    }).html;
    expect(con).toContain('Ver la PQR');
    expect(con).toContain('https://app.example.com/auth/enlace?token=abc');
  });
});

describe('construirCorreoPqrRespuesta', () => {
  const respuesta = {
    nombreDestinatario: 'Juan',
    nombreCopropiedad: 'Torres del Parque',
    codigo: 'PQR-007',
    titulo: 'Filtración',
    autor: 'Ana',
    mensaje: 'Ya enviamos un técnico.',
    enlace: null,
  };

  it('arma el asunto con el código de la PQR', () => {
    expect(construirCorreoPqrRespuesta(respuesta).asunto).toBe(
      'Nueva respuesta en tu PQR PQR-007',
    );
  });

  it('incluye quién respondió y el mensaje, escapados', () => {
    const { html } = construirCorreoPqrRespuesta({
      ...respuesta,
      autor: '<b>Ana</b>',
      mensaje: 'hola\n<script>',
    });

    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(html).toContain('hola<br/>&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('muestra el botón solo si hay enlace de acceso', () => {
    expect(construirCorreoPqrRespuesta(respuesta).html).not.toContain(
      'Ver la respuesta',
    );
    expect(
      construirCorreoPqrRespuesta({
        ...respuesta,
        enlace: 'https://app.example.com/x',
      }).html,
    ).toContain('Ver la respuesta');
  });
});
