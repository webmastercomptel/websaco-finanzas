import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { EnlaceFacturaSchema } from '../../database/schemas/facturacion/enlace-factura.schema';
import { claveCorreo } from '../../common/utils/email.utils';
import { ColeccionMemoria } from '../envio-facturas/testing/coleccion-memoria';
import {
  decisionAnulada,
  MENSAJE_OPACO,
  PISO_DE_TIEMPO_MS,
  RETENCION_TRAS_VENCER_S,
  VIGENCIA_ENLACE_FACTURA_MS,
} from './factura-publica.constantes';
import { EnlaceFacturaService } from './enlace-factura.service';

const oid = () => new Types.ObjectId();
const DIA_MS = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-11-12T15:00:00.000Z').getTime();
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

function montar() {
  const copropiedadId = oid();
  const facturaId = oid();
  const envioFacturaId = oid();
  const enlaces = new ColeccionMemoria(['tokenHash']);
  const servicio = new EnlaceFacturaService(enlaces as never);
  const emitirPara = (
    correo: string,
    sobre: { facturaId?: Types.ObjectId } = {},
  ) =>
    servicio.emitir({
      copropiedadId,
      facturaId: sobre.facturaId ?? facturaId,
      envioFacturaId,
      clave: claveCorreo(correo),
      rol: 'propietario',
    });
  return {
    servicio,
    enlaces,
    emitirPara,
    copropiedadId,
    facturaId,
    envioFacturaId,
  };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(AHORA);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('constantes de factura-publica', () => {
  it('el enlace dura 30 días, se conserva 90 tras vencer y el piso de tiempo es 300 ms', () => {
    expect(VIGENCIA_ENLACE_FACTURA_MS).toBe(30 * DIA_MS);
    expect(RETENCION_TRAS_VENCER_S).toBe(90 * 24 * 60 * 60);
    expect(PISO_DE_TIEMPO_MS).toBe(300);
    expect(MENSAJE_OPACO).toBe(
      'El enlace no es válido o ya no está disponible',
    );
  });

  it('decisionAnulada rechaza por defecto (punto de giro del supuesto 5)', () => {
    expect(decisionAnulada()).toBe('rechazar');
  });
});

describe('EnlaceFacturaSchema', () => {
  it('declara el índice único de tokenHash, el compuesto por factura y clave, y el TTL de 90 días tras expiraEn', () => {
    const indices = EnlaceFacturaSchema.indexes();
    const de = (campos: Record<string, number>) =>
      indices.find(([c]) => JSON.stringify(c) === JSON.stringify(campos))?.[1];

    expect(de({ tokenHash: 1 })).toMatchObject({ unique: true });
    expect(de({ copropiedadId: 1, facturaId: 1, clave: 1 })).toBeDefined();
    expect(de({ expiraEn: 1 })).toMatchObject({
      expireAfterSeconds: RETENCION_TRAS_VENCER_S,
    });
  });
});

describe('EnlaceFacturaService.emitir', () => {
  it('SEC: token is never persisted — guarda solo el SHA-256 del token y la clave, sin el token ni el correo', async () => {
    const m = montar();

    const emitido = await m.emitirPara('ana@x.com');

    expect(emitido.token).toMatch(/^[0-9a-f]{64}$/);
    const [fila] = m.enlaces.docs;
    expect(fila).toMatchObject({
      tokenHash: sha256(emitido.token),
      clave: claveCorreo('ana@x.com'),
      rol: 'propietario',
      usos: 0,
      revocadoEn: null,
      copropiedadId: m.copropiedadId,
      facturaId: m.facturaId,
      envioFacturaId: m.envioFacturaId,
    });
    expect((fila.expiraEn as Date).getTime()).toBe(
      AHORA + VIGENCIA_ENLACE_FACTURA_MS,
    );
    const volcado = JSON.stringify(m.enlaces.docs);
    expect(volcado).not.toContain(emitido.token);
    expect(volcado).not.toContain('ana@x.com');
    expect(emitido.expiraEn.getTime()).toBe(AHORA + VIGENCIA_ENLACE_FACTURA_MS);
    expect(emitido.id).toBe(String(fila._id));
  });

  it('dos direcciones de una factura dan dos filas con tokens distintos; la misma dirección dos veces, dos filas', async () => {
    const m = montar();

    const a = await m.emitirPara('ana@x.com');
    const b = await m.emitirPara('otra@x.com');
    const c = await m.emitirPara('ana@x.com');

    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
    expect(m.enlaces.docs).toHaveLength(3);
  });

  it('un tokenHash repetido lo rechaza el índice único', async () => {
    const m = montar();
    await m.emitirPara('ana@x.com');
    const [fila] = m.enlaces.docs;

    await expect(
      m.enlaces.create({ ...fila, _id: oid() }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('EnlaceFacturaService — revocación', () => {
  it('revocarPorId revoca solo ese enlace de la copropiedad', async () => {
    const m = montar();
    const a = await m.emitirPara('ana@x.com');
    await m.emitirPara('otra@x.com');

    await m.servicio.revocarPorId(m.copropiedadId, a.id);

    expect(m.enlaces.docs.map((d) => d.revocadoEn !== null)).toEqual([
      true,
      false,
    ]);
  });

  it('revocar con la copropiedad equivocada o un id mal formado no toca nada', async () => {
    const m = montar();
    const a = await m.emitirPara('ana@x.com');

    await m.servicio.revocarPorId(oid(), a.id);
    await m.servicio.revocarPorId(m.copropiedadId, 'no-es-un-id');

    expect(m.enlaces.docs[0].revocadoEn).toBeNull();
  });

  it('revocarPorFactura y revocarPorClave revocan solo lo que nombran', async () => {
    const m = montar();
    const otraFactura = oid();
    await m.emitirPara('ana@x.com');
    await m.emitirPara('otra@x.com');
    await m.emitirPara('ana@x.com', { facturaId: otraFactura });

    await m.servicio.revocarPorClave(m.copropiedadId, claveCorreo('ana@x.com'));
    expect(m.enlaces.docs.map((d) => d.revocadoEn !== null)).toEqual([
      true,
      false,
      true,
    ]);

    await m.servicio.revocarPorFactura(m.copropiedadId, m.facturaId);
    expect(m.enlaces.docs.map((d) => d.revocadoEn !== null)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('revocar dos veces conserva el primer revocadoEn', async () => {
    const m = montar();
    const a = await m.emitirPara('ana@x.com');

    await m.servicio.revocarPorId(m.copropiedadId, a.id);
    const primera = m.enlaces.docs[0].revocadoEn as Date;
    jest.spyOn(Date, 'now').mockReturnValue(AHORA + DIA_MS);
    await m.servicio.revocarPorId(m.copropiedadId, a.id);

    expect(m.enlaces.docs[0].revocadoEn).toBe(primera);
  });
});
