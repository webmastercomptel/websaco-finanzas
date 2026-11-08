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
