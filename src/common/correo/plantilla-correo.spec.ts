import { LOGO_CORREO_CID } from './logo-correo';
import {
  renderCajaDetalle,
  renderFilaDetalle,
  renderLineaMeta,
  renderPlantillaCorreo,
} from './plantilla-correo';

describe('renderPlantillaCorreo', () => {
  const base = { heading: 'Hola', bodyHtml: '<p>Cuerpo</p>' };

  it('incluye título, cuerpo y el pie automático', () => {
    const html = renderPlantillaCorreo(base);

    expect(html).toContain('<h1');
    expect(html).toContain('Hola');
    expect(html).toContain('<p>Cuerpo</p>');
    expect(html).toContain('mensaje automático');
  });

  it('el encabezado es el logo incrustado por Content-ID, con alt y tamaño fijos', () => {
    const html = renderPlantillaCorreo(base);

    expect(LOGO_CORREO_CID).toBe('logo-websaco');
    expect(html).toContain('src="cid:logo-websaco"');
    expect(html).toMatch(/<img[^>]*alt="WebSaco"/);
    expect(html).toMatch(/<img[^>]*width="\d+"/);
    expect(html).toMatch(/<img[^>]*height="\d+"/);
    expect(html).toMatch(/<img[^>]*display:\s*block/);
  });

  it('dibuja el botón solo cuando hay enlace, y escapa la dirección', () => {
    const sin = renderPlantillaCorreo(base);
    const con = renderPlantillaCorreo({
      ...base,
      cta: { url: 'https://app.ejemplo.com/a?x=1&y="2"', label: 'Abrir' },
    });

    expect(sin).not.toContain('<a href');
    expect(con).toContain('>Abrir</a>');
    expect(con).toContain('x=1&amp;y=&quot;2&quot;');
  });
});

describe('piezas de detalle', () => {
  it('la caja envuelve el contenido y la fila final no deja margen inferior', () => {
    expect(renderCajaDetalle('<b>x</b>')).toContain('<b>x</b>');
    expect(renderFilaDetalle('Fecha', 'hoy', true)).toContain('margin: 0 0 0');
    expect(renderFilaDetalle('Fecha', 'hoy')).toContain('margin: 0 0 14px');
  });

  it('la línea meta descarta lo vacío y devuelve cadena vacía si no queda nada', () => {
    expect(renderLineaMeta(['A', false, null, 'B'])).toContain(
      'A&nbsp;·&nbsp;B',
    );
    expect(renderLineaMeta([false, undefined])).toBe('');
  });
});
