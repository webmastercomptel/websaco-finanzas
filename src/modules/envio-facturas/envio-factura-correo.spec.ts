import {
  construirAsuntoFactura,
  construirCorreoFactura,
  construirEnlacePdf,
  construirUrlPortal,
  etiquetaFechaVencimiento,
  type DatosCorreoFactura,
} from './envio-factura-correo';

const TOKEN = 'ab12'.repeat(16);
const FRONTEND = 'https://app.ejemplo.com';

const datos = (over: Partial<DatosCorreoFactura> = {}): DatosCorreoFactura => ({
  nombreDestinatario: 'Ana Pérez',
  nombreCopropiedad: 'Torres del Parque',
  numeroCompleto: 'FV-0001',
  codigoInmueble: 'A-101',
  periodo: 'octubre de 2026',
  enlacePdf: construirEnlacePdf(FRONTEND, TOKEN),
  venceEl: '12 de diciembre de 2026',
  urlPortal: construirUrlPortal(FRONTEND),
  ...over,
});

describe('construirEnlacePdf y construirUrlPortal', () => {
  it('el token viaja en el fragmento de /factura, sin consulta', () => {
    const enlace = construirEnlacePdf(FRONTEND, TOKEN);
    const url = new URL(enlace);

    expect(enlace).toBe(`https://app.ejemplo.com/factura#${TOKEN}`);
    expect(url.pathname).toBe('/factura');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#${TOKEN}`);
  });

  it('el portal se enlaza sin consulta ni fragmento', () => {
    const url = new URL(construirUrlPortal(`${FRONTEND}/`));

    expect(url.pathname).toBe('/portal/facturas');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });
});

describe('etiquetaFechaVencimiento', () => {
  it('escribe el día de Bogotá en español: un enlace creado el 2026-11-12 vence el 12 de diciembre de 2026', () => {
    const creado = new Date('2026-11-12T15:00:00.000Z').getTime();

    expect(
      etiquetaFechaVencimiento(new Date(creado + 30 * 24 * 60 * 60 * 1000)),
    ).toBe('12 de diciembre de 2026');
  });

  it('usa el día de Bogotá, no el de UTC (madrugada UTC = noche anterior en Bogotá)', () => {
    expect(etiquetaFechaVencimiento(new Date('2026-12-13T02:00:00.000Z'))).toBe(
      '12 de diciembre de 2026',
    );
  });
});

describe('construirCorreoFactura', () => {
  it('SEC: invoice mail has no session link and no query token — el enlace al PDF va una vez, en el fragmento, y no hay enlace de sesión', () => {
    const { html } = construirCorreoFactura(datos());

    expect(html.split('/factura#').length - 1).toBe(1);
    expect(html).toContain(`/factura#${TOKEN}`);
    expect(html).not.toContain('/auth/enlace');
    expect(html).not.toContain('token=');
    expect(html).not.toMatch(/\?[^"\s]*token/);
    expect(html.match(/[0-9a-f]{64}/g)).toEqual([TOKEN]);
  });

  it('lleva el botón «Ver mi factura», el vencimiento personal y el portal sin parámetros', () => {
    const { html } = construirCorreoFactura(datos());

    expect(html).toContain('Ver mi factura');
    expect(html).toContain(
      'Este enlace es personal; vence el 12 de diciembre de 2026.',
    );
    expect(html).toContain('https://app.ejemplo.com/portal/facturas');
    expect(html).not.toContain('/portal/facturas?');
    expect(html).not.toContain('/portal/facturas#');
  });

  it('dice que la factura no va adjunta, no adjunta nada y no escribe montos', () => {
    const { html, asunto } = construirCorreoFactura(datos());

    expect(asunto).toBe('Tu factura FV-0001 ya está disponible');
    expect(asunto).toBe(construirAsuntoFactura('FV-0001'));
    expect(html).toContain('no va adjunta');
    expect(html).not.toMatch(/\$|total|saldo|Por seguridad/i);
    expect(html).toContain('FV-0001');
    expect(html).toContain('A-101');
    expect(html).toContain('octubre de 2026');
    expect(html).toContain('cid:logo-websaco');
    expect(html).not.toMatch(/<a [^>]*download/);
  });

  it('escapa lo que no es nuestro: el nombre del titular no inyecta HTML', () => {
    const { html } = construirCorreoFactura(
      datos({ nombreDestinatario: '<b>Ana</b>' }),
    );

    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    expect(html).not.toContain('<b>Ana</b>');
  });

  it('con un periodo vacío no escribe el fragmento del periodo', () => {
    expect(construirCorreoFactura(datos({ periodo: '' })).html).not.toContain(
      'correspondiente a',
    );
  });
});
