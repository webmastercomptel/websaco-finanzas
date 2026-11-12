import { Types } from 'mongoose';
import type { EnvioFacturaDocument } from '../../database/schemas/facturacion/envio-factura.schema';
import { toEnvioFactura } from './envio-facturas.mapper';

const entrada = (clave: string) => ({
  clave,
  rol: 'propietario',
  terceroId: new Types.ObjectId(),
  aceptadoEn: new Date('2026-11-12T10:00:00Z'),
});

const doc = (over: Record<string, unknown> = {}): EnvioFacturaDocument =>
  ({
    _id: new Types.ObjectId(),
    facturaId: new Types.ObjectId(),
    inmuebleId: new Types.ObjectId(),
    codigoInmueble: 'A-101',
    numeroCompleto: 'FV-1',
    loteId: null,
    estado: 'pendiente_envio',
    marcadoPorNombre: 'Ana',
    marcadoEn: new Date('2026-11-12T09:00:00Z'),
    procesadoPorNombre: '',
    liberadaEn: undefined,
    enviadoEn: null,
    destinatariosTotal: 4,
    notificadosIds: [],
    correosEnviadosIds: [],
    correosEntregados: [],
    intentos: 0,
    ultimoError: null,
    ...over,
  }) as unknown as EnvioFacturaDocument;

describe('toEnvioFactura — contadores por dirección', () => {
  it('destinatarios son las direcciones del último intento y correosAceptados las entregadas', () => {
    const r = toEnvioFactura(
      doc({
        destinatariosTotal: 4,
        correosEntregados: [entrada('a'), entrada('b'), entrada('c')],
      }),
    );

    expect(r.destinatarios).toBe(4);
    expect(r.correosAceptados).toBe(3);
  });

  it('correosEnviados conserva su sentido heredado: las cuentas de correosEnviadosIds', () => {
    const r = toEnvioFactura(
      doc({
        correosEnviadosIds: [new Types.ObjectId(), new Types.ObjectId()],
        correosEntregados: [entrada('a')],
      }),
    );

    expect(r.correosEnviados).toBe(2);
  });

  it('una fila escrita solo por el código anterior se mapea sin error y sin correosAceptados', () => {
    const r = toEnvioFactura(
      doc({
        correosEntregados: undefined,
        correosEnviadosIds: [new Types.ObjectId()],
      }),
    );

    expect(r.correosAceptados).toBeUndefined();
    expect(r.correosEnviados).toBe(1);
  });

  it('una fila nueva sin entregas todavía muestra 0 aceptados', () => {
    expect(toEnvioFactura(doc()).correosAceptados).toBe(0);
  });

  it('no filtra claves, terceros ni ids de cuentas', () => {
    const r = toEnvioFactura(doc({ correosEntregados: [entrada('secreta')] }));

    expect(JSON.stringify(r)).not.toContain('secreta');
    expect(r).not.toHaveProperty('correosEntregados');
  });
});
