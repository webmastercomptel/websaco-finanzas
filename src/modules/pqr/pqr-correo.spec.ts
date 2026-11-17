import {
  construirCorreoPqrAcuse,
  construirCorreoPqrCierre,
  construirCorreoPqrNueva,
  construirCorreoPqrOrgano,
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

describe('correos del flujo en etapas', () => {
  it('el acuse lleva el asunto y la frase de radicado, y escapa el título', () => {
    const { asunto, html } = construirCorreoPqrAcuse({
      nombreDestinatario: 'Ana',
      nombreCopropiedad: 'Torres del Parque',
      codigo: 'PQR-0042',
      titulo: '<script>alert(1)</script>',
      fechaRadicacion: '17/11/2026',
      enlace: null,
    });

    expect(asunto).toBe('Recibimos su PQRS · Radicado PQR-0042');
    expect(html).toContain(
      'Hemos recibido su PQRS bajo el radicado PQR-0042. En poco tiempo recibirá respuesta.',
    );
    expect(html).toContain('17/11/2026');
    expect(html).not.toContain('<script>');
  });

  it('el aviso al órgano lleva el asunto y no trae enlace', () => {
    const { asunto, html } = construirCorreoPqrOrgano({
      nombreCopropiedad: 'Torres del Parque',
      organo: 'Comité de Convivencia',
      codigo: 'PQR-0042',
      tipo: 'quejas',
      titulo: '<b>Ruido</b>',
      descripcion: 'Música alta',
      unidad: 'A-101',
      fechaLimite: '30/11/2026',
    });

    expect(asunto).toBe('PQRS PQR-0042 asignada al Comité de Convivencia');
    expect(html).toContain('30/11/2026');
    expect(html).not.toContain('<b>Ruido</b>');
    expect(html).not.toContain('href="http');
  });

  it('el cierre lleva el asunto, el mensaje y el botón solo si hay enlace', () => {
    const base = {
      nombreDestinatario: 'Ana',
      nombreCopropiedad: 'Torres del Parque',
      codigo: 'PQR-0042',
      titulo: 'Ruido',
      mensaje: 'Resuelto <i>ya</i>',
    };
    const sin = construirCorreoPqrCierre({ ...base, enlace: null });
    const con = construirCorreoPqrCierre({
      ...base,
      enlace: 'https://app.example.com/x',
    });

    expect(sin.asunto).toBe('Respuesta a su PQRS · Radicado PQR-0042');
    expect(sin.html).toContain('Su PQRS quedó cerrada.');
    expect(sin.html).not.toContain('<i>ya</i>');
    expect(sin.html).not.toContain('https://app.example.com/x');
    expect(con.html).toContain('https://app.example.com/x');
  });
});
