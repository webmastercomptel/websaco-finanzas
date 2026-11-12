import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CorreoService } from './correo.service';

jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn(),
}));

const { send: mockSend, setApiKey: mockSetApiKey } = jest.requireMock<{
  send: jest.Mock;
  setApiKey: jest.Mock;
}>('@sendgrid/mail');

function crear(valores: Record<string, string | undefined>): CorreoService {
  const config = {
    get: (clave: string) => valores[clave],
  } as unknown as ConfigService;
  return new CorreoService(config);
}

const CONFIGURADO = {
  'app.sendgridApiKey': 'SG.clave',
  'app.sendgridFromEmail': 'notificaciones@ejemplo.com',
  'app.sendgridFromName': 'WebSaco',
};

describe('CorreoService', () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue([{ statusCode: 202 }, {}]);
    mockSetApiKey.mockReset();
  });

  it('con clave y remitente configura SendGrid y se declara configurado', () => {
    const servicio = crear(CONFIGURADO);

    expect(servicio.estaConfigurado()).toBe(true);
    expect(mockSetApiKey).toHaveBeenCalledWith('SG.clave');
  });

  it('sin configuración no se declara configurado ni toca SendGrid', () => {
    const servicio = crear({});

    expect(servicio.estaConfigurado()).toBe(false);
    expect(mockSetApiKey).not.toHaveBeenCalled();
  });

  it('envía con el remitente configurado y devuelve true', async () => {
    const servicio = crear(CONFIGURADO);

    const ok = await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'Su factura',
      html: '<p>Hola</p>',
    });

    expect(ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'vecino@ejemplo.com',
        from: { email: 'notificaciones@ejemplo.com', name: 'WebSaco' },
        subject: 'Su factura',
        html: '<p>Hola</p>',
      }),
    );
  });

  it('adjunta archivos codificados en base64', async () => {
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'Su factura',
      html: '<p>Hola</p>',
      adjuntos: [
        {
          nombre: 'factura.pdf',
          tipo: 'application/pdf',
          contenido: Buffer.from('pdf'),
        },
      ],
    });

    const [enviado] = mockSend.mock.calls[0] as [
      { attachments: Array<Record<string, string>> },
    ];
    expect(enviado.attachments).toEqual([
      {
        content: Buffer.from('pdf').toString('base64'),
        filename: 'factura.pdf',
        type: 'application/pdf',
        disposition: 'attachment',
      },
    ]);
  });

  it('sin configuración devuelve false y no envía nada', async () => {
    const servicio = crear({});

    const ok = await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'x',
      html: 'x',
    });

    expect(ok).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de SendGrid se reporta como false', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    const servicio = crear(CONFIGURADO);

    await expect(
      servicio.enviar({ para: 'a@b.co', asunto: 'x', html: 'x' }),
    ).resolves.toBe(false);
  });
});

describe('CorreoService — logo incrustado', () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue([{ statusCode: 202 }, {}]);
  });

  const enviados = () =>
    (
      mockSend.mock.calls[0] as [
        { attachments?: Array<Record<string, string>> },
      ]
    )[0].attachments;

  it('si el HTML referencia cid:logo-websaco adjunta el logo inline con su content_id', async () => {
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'x',
      html: '<img src="cid:logo-websaco" alt="WebSaco">',
    });

    const adjuntos = enviados() ?? [];
    expect(adjuntos).toHaveLength(1);
    expect(adjuntos[0]).toEqual({
      content: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/) as string,
      filename: 'websaco-logo.png',
      type: 'image/png',
      disposition: 'inline',
      content_id: 'logo-websaco',
    });
    expect(adjuntos[0].content.length).toBeGreaterThan(100);
  });

  it('el logo viaja junto a los adjuntos del mensaje, sin pisarlos', async () => {
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'x',
      html: '<img src="cid:logo-websaco">',
      adjuntos: [
        {
          nombre: 'factura.pdf',
          tipo: 'application/pdf',
          contenido: Buffer.from('pdf'),
        },
      ],
    });

    const adjuntos = enviados() ?? [];
    expect(adjuntos.map((a) => a.filename)).toEqual([
      'factura.pdf',
      'websaco-logo.png',
    ]);
    expect(adjuntos[0].disposition).toBe('attachment');
  });

  it('un HTML sin plantilla no recibe el logo ni adjuntos', async () => {
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'x',
      html: '<p>Hola</p>',
    });

    expect(enviados()).toBeUndefined();
  });

  it('sin SendGrid configurado sigue sin enviar nada (solo log)', async () => {
    const servicio = crear({});

    const ok = await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'x',
      html: '<img src="cid:logo-websaco">',
    });

    expect(ok).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('CorreoService — sin seguimiento de SendGrid', () => {
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue([{ statusCode: 202 }, {}]);
  });

  it('apaga el seguimiento de clics y de apertura en cada mensaje (los enlaces de acceso son credenciales)', async () => {
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({
      para: 'vecino@ejemplo.com',
      asunto: 'Su factura',
      html: '<a href="https://app.ejemplo.com/auth/enlace?token=t">Ver</a>',
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
        },
      }),
    );
  });
});

describe('CorreoService — registros sin direcciones completas', () => {
  let errorSpy: jest.SpyInstance;
  let todoLoRegistrado: () => string;

  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue([{ statusCode: 202 }, {}]);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const otros = [
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
      jest.spyOn(Logger.prototype, 'log').mockImplementation(),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(),
    ];
    todoLoRegistrado = () =>
      [errorSpy, ...otros]
        .flatMap((espia) => espia.mock.calls as unknown[][])
        .map((llamada) => JSON.stringify(llamada))
        .join('\n');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SEC: CorreoService never logs a full address — un fallo de envío registra la dirección enmascarada', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({ para: 'ana@x.com', asunto: 'x', html: 'x' });

    expect(todoLoRegistrado()).toContain('a***@x.com');
    expect(todoLoRegistrado()).not.toContain('ana@x.com');
  });

  it('SEC: CorreoService never logs a full address — sin SendGrid configurado registra solo la dirección enmascarada', async () => {
    const servicio = crear({});

    const ok = await servicio.enviar({
      para: 'ana@x.com',
      asunto: 'x',
      html: 'x',
    });

    expect(ok).toBe(false);
    expect(todoLoRegistrado()).toContain('a***@x.com');
    expect(todoLoRegistrado()).not.toContain('ana@x.com');
  });

  it('SEC: CorreoService never logs a full address — el texto de error del proveedor también se enmascara', async () => {
    mockSend.mockRejectedValue(
      new Error('The to address ana@x.com does not exist; retry ANA@X.COM'),
    );
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({ para: 'ana@x.com', asunto: 'x', html: 'x' });

    const registrado = todoLoRegistrado();
    expect(registrado).not.toMatch(/ana@x\.com/i);
    expect(registrado).toContain('a***@x.com');
  });

  it('SEC: con sinRegistrarDestinatario ningún registro nombra al destinatario, ni enmascarado', async () => {
    mockSend.mockRejectedValue(
      new Error('The to address ana@x.com does not exist'),
    );
    const fallo = crear(CONFIGURADO);
    const sinConfigurar = crear({});

    await fallo.enviar({
      para: 'ana@x.com',
      asunto: 'x',
      html: 'x',
      sinRegistrarDestinatario: true,
    });
    await sinConfigurar.enviar({
      para: 'ana@x.com',
      asunto: 'x',
      html: 'x',
      sinRegistrarDestinatario: true,
    });

    const registrado = todoLoRegistrado();
    expect(registrado).not.toBe('');
    expect(registrado.toLowerCase()).not.toContain('ana@x.com');
    expect(registrado).not.toContain('a***@x.com');
    expect(registrado).not.toContain('does not exist');
  });

  it('una dirección sin arroba se registra como ***', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    const servicio = crear(CONFIGURADO);

    await servicio.enviar({ para: 'sin-arroba', asunto: 'x', html: 'x' });

    expect(todoLoRegistrado()).toContain('***');
    expect(todoLoRegistrado()).not.toContain('sin-arroba');
  });

  it('un envío aceptado devuelve true, no registra nada y mantiene el seguimiento apagado', async () => {
    const servicio = crear(CONFIGURADO);

    const ok = await servicio.enviar({
      para: 'ana@x.com',
      asunto: 'x',
      html: 'x',
    });

    expect(ok).toBe(true);
    expect(todoLoRegistrado()).toBe('');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
        },
      }),
    );
  });
});
