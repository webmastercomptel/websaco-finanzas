import {
  compilarPlantilla,
  construirAsuntoAnuncio,
  construirCorreoAnuncio,
  personalizarContenido,
} from './anuncio-correo';

const base = {
  nombreCopropiedad: 'Torres del Parque',
  titulo: 'Corte de agua programado',
  contenido: 'El sábado no habrá agua de 9 a 13hs.\nDisculpen las molestias.',
  autor: 'Administración',
  fecha: new Date('2026-01-15T15:00:00.000Z'),
  enlace: 'https://app.test/auth/enlace?token=abc',
};

describe('compilarPlantilla', () => {
  it('sustituye los marcadores conocidos y deja visibles los desconocidos', () => {
    expect(
      compilarPlantilla('Hola {{nombre}}, {{otro}}', { nombre: 'Ana' }),
    ).toBe('Hola Ana, {{otro}}');
  });

  it('no resuelve claves heredadas del prototipo ({{constructor}})', () => {
    expect(compilarPlantilla('{{constructor}} {{toString}}', {})).toBe(
      '{{constructor}} {{toString}}',
    );
  });
});

describe('personalizarContenido', () => {
  it('acepta {{nombre}} y el {{name}} heredado del sistema anterior', () => {
    expect(personalizarContenido('Hola {{nombre}} / {{name}}', 'Ana')).toBe(
      'Hola Ana / Ana',
    );
  });

  it('devuelve texto plano: no escapa (el escape ocurre una sola vez al armar el correo)', () => {
    expect(personalizarContenido('Hola {{nombre}}', 'A&B')).toBe('Hola A&B');
  });
});

describe('construirCorreoAnuncio', () => {
  it('arma el asunto con la copropiedad y el título', () => {
    expect(construirAsuntoAnuncio('Torres', 'Corte')).toBe(
      'Nuevo anuncio en Torres: Corte',
    );
    expect(construirCorreoAnuncio(base).asunto).toBe(
      'Nuevo anuncio en Torres del Parque: Corte de agua programado',
    );
  });

  it('preserva los saltos de línea del contenido como <br/>', () => {
    const { html } = construirCorreoAnuncio(base);
    expect(html).toContain('9 a 13hs.<br/>Disculpen');
  });

  it('incluye autor y botón cuando hay enlace', () => {
    const { html } = construirCorreoAnuncio(base);
    expect(html).toContain('Publicado por Administración');
    expect(html).toContain('Ver el anuncio');
    expect(html).toContain('https://app.test/auth/enlace?token=abc');
  });

  it('sin enlace no hay botón, y sin autor no hay "Publicado por"', () => {
    const { html } = construirCorreoAnuncio({
      ...base,
      enlace: null,
      autor: '',
    });
    expect(html).not.toContain('Ver el anuncio');
    expect(html).not.toContain('Publicado por');
  });

  it('escapa título, contenido y autor tecleados por un usuario', () => {
    const { html } = construirCorreoAnuncio({
      ...base,
      titulo: '<script>alert(1)</script>',
      contenido: '<b>hola</b> & "chau"',
      autor: '<i>yo</i>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>hola</b>');
    expect(html).not.toContain('<i>yo</i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;hola&lt;/b&gt; &amp; &quot;chau&quot;');
  });
});

describe('la fecha del anuncio es un instante real', () => {
  it('una publicación a las 22:00 en Bogotá conserva el día y la hora de Bogotá', () => {
    // 22:00 in Bogotá on the 20th is 03:00 UTC of the 21st.
    const { html } = construirCorreoAnuncio({
      ...base,
      fecha: new Date('2026-11-21T03:00:00.000Z'),
    });

    expect(html).toContain('20/11/2026');
    expect(html).toMatch(/10:00\s?p\.\s?m\./);
  });
});
