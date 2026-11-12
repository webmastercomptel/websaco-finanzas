import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
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

type Doc = Record<string, unknown>;

/** A two-page "lote" PDF: page 1 is 200x200, page 2 is 300x300. */
async function pdfDeLote(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  pdf.addPage([300, 300]);
  return Buffer.from(await pdf.save());
}

async function medidaDePagina(bytes: Uint8Array): Promise<[number, number]> {
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(1);
  const { width, height } = pdf.getPage(0).getSize();
  return [width, height];
}

/** One unit with an owner (2 addresses), a tenant (1) and a released invoice. */
async function montarMundo() {
  const copropiedadId = oid();
  const loteId = oid();
  const titular = {
    _id: oid(),
    copropiedadId,
    estado: 'active',
    nombre: 'Ana',
    emails: ['ana@x.com', 'otra@x.com'],
  };
  const arrendatario = {
    _id: oid(),
    copropiedadId,
    estado: 'active',
    nombre: 'Luis',
    emails: ['luis@x.com'],
  };
  const inmueble = {
    _id: oid(),
    copropiedadId,
    estado: 'active',
    titularId: titular._id,
    arrendatarioId: arrendatario._id,
  };
  const factura = {
    _id: oid(),
    copropiedadId,
    inmuebleId: inmueble._id,
    loteId,
    estado: 'emitida',
    numeroCompleto: 'FV-0001',
    printSnapshot: { ok: true },
    paginaEnLote: 2,
  };
  const envio = {
    _id: oid(),
    copropiedadId,
    facturaId: factura._id,
    inmuebleId: inmueble._id,
    liberadaEn: new Date(AHORA - DIA_MS),
  };
  const copropiedad = {
    _id: copropiedadId,
    estado: 'active',
    modulosContratados: ['finanzas'],
  };

  const enlaces = new ColeccionMemoria(['tokenHash']);
  const copropiedades = new ColeccionMemoria();
  const facturas = new ColeccionMemoria();
  const envios = new ColeccionMemoria();
  const inmuebles = new ColeccionMemoria();
  const terceros = new ColeccionMemoria();
  copropiedades.insertar(copropiedad);
  facturas.insertar(factura);
  envios.insertar(envio);
  inmuebles.insertar(inmueble);
  terceros.insertar(titular);
  terceros.insertar(arrendatario);

  const presentacion = {
    buscar: jest.fn().mockResolvedValue({ objectPath: 'lotes/1.pdf' }),
  };
  const storage = {
    descargarBytes: jest.fn().mockResolvedValue(await pdfDeLote()),
  };
  const servicio = new EnlaceFacturaService(
    enlaces as never,
    copropiedades as never,
    facturas as never,
    envios as never,
    inmuebles as never,
    terceros as never,
    presentacion as never,
    storage as never,
  );
  const emitirPara = (
    correo: string,
    rol: 'propietario' | 'arrendatario' = 'propietario',
    sobre: { facturaId?: Types.ObjectId } = {},
  ) =>
    servicio.emitir({
      copropiedadId,
      facturaId: sobre.facturaId ?? factura._id,
      envioFacturaId: envio._id,
      clave: claveCorreo(correo),
      rol,
    });
  return {
    servicio,
    emitirPara,
    copropiedadId,
    titular,
    arrendatario,
    inmueble,
    factura,
    envio,
    copropiedad,
    colecciones: {
      enlaces,
      copropiedades,
      facturas,
      envios,
      inmuebles,
      terceros,
    },
    presentacion,
    storage,
  };
}

let registro: jest.SpyInstance[];
let lineasRegistradas: () => string;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(AHORA);
  registro = (['error', 'warn', 'log', 'debug', 'verbose'] as const).map((n) =>
    jest.spyOn(Logger.prototype, n).mockImplementation(),
  );
  lineasRegistradas = () =>
    registro
      .flatMap((e) => e.mock.calls as unknown[][])
      .map((c) => JSON.stringify(c))
      .join('\n');
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
    expect(de({ copropiedadId: 1, facturaId: 1, clave: 1 })).toMatchObject({
      unique: true,
    });
    expect(de({ expiraEn: 1 })).toMatchObject({
      expireAfterSeconds: RETENCION_TRAS_VENCER_S,
    });
  });
});

describe('EnlaceFacturaService.emitir', () => {
  it('SEC: token is never persisted — guarda solo el SHA-256 del token y la clave, sin el token ni el correo', async () => {
    const m = await montarMundo();

    const emitido = await m.emitirPara('ana@x.com');

    expect(emitido.token).toMatch(/^[0-9a-f]{64}$/);
    const [fila] = m.colecciones.enlaces.docs;
    expect(fila).toMatchObject({
      tokenHash: sha256(emitido.token),
      clave: claveCorreo('ana@x.com'),
      rol: 'propietario',
      usos: 0,
      revocadoEn: null,
      copropiedadId: m.copropiedadId,
      facturaId: m.factura._id,
      envioFacturaId: m.envio._id,
    });
    expect((fila.expiraEn as Date).getTime()).toBe(
      AHORA + VIGENCIA_ENLACE_FACTURA_MS,
    );
    const volcado = JSON.stringify(m.colecciones.enlaces.docs);
    expect(volcado).not.toContain(emitido.token);
    expect(volcado).not.toContain('ana@x.com');
    expect(emitido.expiraEn.getTime()).toBe(AHORA + VIGENCIA_ENLACE_FACTURA_MS);
    expect(emitido.id).toBe(String(fila._id));
    expect(lineasRegistradas()).not.toContain(emitido.token);
  });

  it('dos direcciones de una factura dan dos filas con tokens distintos', async () => {
    const m = await montarMundo();

    const a = await m.emitirPara('ana@x.com');
    const b = await m.emitirPara('otra@x.com');

    expect(a.token).not.toBe(b.token);
    expect(m.colecciones.enlaces.docs).toHaveLength(2);
  });

  it('SEC: one link per (invoice, address) — emitir otra vez para la misma dirección rota el token en la MISMA fila: el viejo deja de servir, el nuevo sirve', async () => {
    const m = await montarMundo();
    const viejo = await m.emitirPara('ana@x.com');
    jest.spyOn(Date, 'now').mockReturnValue(AHORA + 5 * DIA_MS);

    const nuevo = await m.emitirPara('ana@x.com');

    expect(nuevo.token).not.toBe(viejo.token);
    expect(nuevo.id).toBe(viejo.id);
    expect(m.colecciones.enlaces.docs).toHaveLength(1);
    const [fila] = m.colecciones.enlaces.docs;
    expect(fila.tokenHash).toBe(sha256(nuevo.token));
    expect((fila.expiraEn as Date).getTime()).toBe(
      AHORA + 5 * DIA_MS + VIGENCIA_ENLACE_FACTURA_MS,
    );
    expect(nuevo.expiraEn.getTime()).toBe(
      AHORA + 5 * DIA_MS + VIGENCIA_ENLACE_FACTURA_MS,
    );
    expect(await m.servicio.resolver(viejo.token)).toBeNull();
    expect(lineasRegistradas()).toContain('rechazado: desconocido');
    expect(await m.servicio.resolver(nuevo.token)).not.toBeNull();
    expect(JSON.stringify(m.colecciones.enlaces.docs)).not.toContain(
      nuevo.token,
    );
  });

  it('SEC: one link per (invoice, address) — dos emisiones simultáneas para la misma dirección dejan UNA fila y solo un token vale', async () => {
    const m = await montarMundo();

    const [a, b] = await Promise.all([
      m.emitirPara('ana@x.com'),
      m.emitirPara('ana@x.com'),
    ]);

    expect(m.colecciones.enlaces.docs).toHaveLength(1);
    expect(a.id).toBe(b.id);
    const sirven = [
      (await m.servicio.resolver(a.token)) !== null,
      (await m.servicio.resolver(b.token)) !== null,
    ];
    expect(sirven.filter(Boolean)).toHaveLength(1);
  });

  it('volver a emitir tras una revocación deja la fila sin revocar, con el token nuevo', async () => {
    const m = await montarMundo();
    const viejo = await m.emitirPara('ana@x.com');
    await m.servicio.revocarPorId(m.copropiedadId, viejo.id, viejo.token);

    const nuevo = await m.emitirPara('ana@x.com');

    expect(m.colecciones.enlaces.docs[0].revocadoEn).toBeNull();
    expect(await m.servicio.resolver(nuevo.token)).not.toBeNull();
    expect(await m.servicio.resolver(viejo.token)).toBeNull();
  });

  it('una revocación tardía del token anterior no mata el enlace ya rotado', async () => {
    const m = await montarMundo();
    const viejo = await m.emitirPara('ana@x.com');
    const nuevo = await m.emitirPara('ana@x.com');

    // The processor that minted `viejo` saw its e-mail refused, late.
    await m.servicio.revocarPorId(m.copropiedadId, viejo.id, viejo.token);

    expect(m.colecciones.enlaces.docs[0].revocadoEn).toBeNull();
    expect(await m.servicio.resolver(nuevo.token)).not.toBeNull();
  });

  it('los enlaces ya emitidos conservan su vencimiento aunque pase el tiempo', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('ana@x.com');
    const [fila] = m.colecciones.enlaces.docs;
    const original = (fila.expiraEn as Date).getTime();

    jest.spyOn(Date, 'now').mockReturnValue(AHORA + 29 * DIA_MS);

    expect((fila.expiraEn as Date).getTime()).toBe(original);
    expect(await m.servicio.resolver(token)).not.toBeNull();
  });
});

describe('EnlaceFacturaService.resolver', () => {
  it('caso de control: sirve la página de SU factura (y solo esa página)', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('ana@x.com');

    const resultado = await m.servicio.resolver(token);

    expect(resultado).not.toBeNull();
    expect(resultado?.numeroCompleto).toBe('FV-0001');
    expect(resultado?.envioFacturaId).toBe(String(m.envio._id));
    expect(resultado?.enlaceId).toBe(String(m.colecciones.enlaces.docs[0]._id));
    expect(await medidaDePagina(resultado!.bytes)).toEqual([300, 300]);
  });

  it('el arrendatario también recibe: su enlace sirve', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('luis@x.com', 'arrendatario');

    expect(await m.servicio.resolver(token)).not.toBeNull();
  });

  it('con 3 días por vencer sirve; 1 segundo después del vencimiento y a los 31 días, no', async () => {
    const m = await montarMundo();
    const { token, expiraEn } = await m.emitirPara('ana@x.com');

    jest.spyOn(Date, 'now').mockReturnValue(expiraEn.getTime() - 3 * DIA_MS);
    expect(await m.servicio.resolver(token)).not.toBeNull();

    jest.spyOn(Date, 'now').mockReturnValue(expiraEn.getTime() + 1000);
    expect(await m.servicio.resolver(token)).toBeNull();

    jest.spyOn(Date, 'now').mockReturnValue(AHORA + 31 * DIA_MS);
    expect(await m.servicio.resolver(token)).toBeNull();
  });

  it.each([
    ['vacío', ''],
    ['una palabra', 'hola'],
    ['63 hex', 'a'.repeat(63)],
    ['65 hex', 'a'.repeat(65)],
    ['64 caracteres no hex', 'z'.repeat(64)],
    ['64 hex en mayúsculas', 'A'.repeat(64)],
  ])(
    'SEC: every refusal cause resolves to null — token mal formado (%s)',
    async (_n, token) => {
      const m = await montarMundo();
      await m.emitirPara('ana@x.com');

      expect(await m.servicio.resolver(token)).toBeNull();
    },
  );

  const causas: Array<
    [string, (m: Awaited<ReturnType<typeof montarMundo>>) => void]
  > = [
    ['token desconocido', () => undefined],
    [
      'revocado',
      (m) => (m.colecciones.enlaces.docs[0].revocadoEn = new Date()),
    ],
    [
      'copropiedad inactiva',
      (m) => (m.colecciones.copropiedades.docs[0].estado = 'inactive'),
    ],
    [
      'sin el módulo finanzas',
      (m) =>
        (m.colecciones.copropiedades.docs[0].modulosContratados = [
          'administracion',
        ]),
    ],
    [
      'la copropiedad del enlace ya no existe',
      (m) => m.colecciones.copropiedades.docs.splice(0),
    ],
    [
      'factura de otra copropiedad (fila forjada)',
      (m) => (m.colecciones.facturas.docs[0].copropiedadId = oid()),
    ],
    [
      'factura anulada',
      (m) => (m.colecciones.facturas.docs[0].estado = 'anulada'),
    ],
    [
      'sin envío liberado',
      (m) => delete m.colecciones.envios.docs[0].liberadaEn,
    ],
    [
      'cambió el titular',
      (m) => {
        const otro = {
          _id: oid(),
          copropiedadId: m.copropiedadId,
          estado: 'active',
          nombre: 'Nuevo',
          emails: ['nuevo@x.com'],
        };
        m.colecciones.terceros.insertar(otro);
        m.colecciones.inmuebles.docs[0].titularId = otro._id;
      },
    ],
    [
      'la dirección se quitó de la ficha',
      (m) => (m.colecciones.terceros.docs[0].emails = ['otra@x.com']),
    ],
    [
      'la dirección se corrigió (typo)',
      (m) =>
        (m.colecciones.terceros.docs[0].emails = ['ana@x.co', 'otra@x.com']),
    ],
    [
      'tercero inactivo',
      (m) => (m.colecciones.terceros.docs[0].estado = 'inactive'),
    ],
    [
      'inmueble inactivo',
      (m) => (m.colecciones.inmuebles.docs[0].estado = 'inactive'),
    ],
    [
      'sin página individual',
      (m) => (m.colecciones.facturas.docs[0].paginaEnLote = null),
    ],
    ['sin PDF del lote', (m) => m.presentacion.buscar.mockResolvedValue(null)],
    [
      'falla el almacenamiento',
      (m) =>
        m.storage.descargarBytes.mockRejectedValue(
          new Error('boom factura 65f0 gs://bucket/lotes/1.pdf'),
        ),
    ],
  ];

  it.each(causas)(
    'SEC: every refusal cause resolves to null — %s',
    async (nombre, romper) => {
      const m = await montarMundo();
      const { token } = await m.emitirPara('ana@x.com');
      if (nombre === 'token desconocido') {
        expect(await m.servicio.resolver(sha256('otro'))).toBeNull();
        return;
      }
      romper(m);

      await expect(m.servicio.resolver(token)).resolves.toBeNull();
      expect(m.colecciones.enlaces.docs[0].usos).toBe(0);
      expect(lineasRegistradas()).not.toContain(token);
      expect(lineasRegistradas()).not.toContain(sha256(token));
      expect(lineasRegistradas()).not.toContain('ana@x.com');
    },
  );

  it('SEC: every refusal cause resolves to null — cualquier excepción de la consulta se vuelve null', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('ana@x.com');
    jest.spyOn(m.colecciones.facturas, 'findOne').mockImplementation(() => {
      throw new Error('La factura 65f0 no existe');
    });

    await expect(m.servicio.resolver(token)).resolves.toBeNull();
  });

  it('la dirección compartida entre titular y arrendatario sigue valiendo si se quita al arrendatario', async () => {
    const m = await montarMundo();
    m.colecciones.terceros.docs[1].emails = ['ana@x.com'];
    const { token } = await m.emitirPara('ana@x.com');

    m.colecciones.inmuebles.docs[0].arrendatarioId = null;

    expect(await m.servicio.resolver(token)).not.toBeNull();
  });

  it('el enlace del arrendatario deja de servir al terminar el arriendo', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('luis@x.com', 'arrendatario');

    m.colecciones.inmuebles.docs[0].arrendatarioId = null;

    expect(await m.servicio.resolver(token)).toBeNull();
  });

  it('corregir una dirección solo mata su enlace: los de las otras direcciones siguen sirviendo', async () => {
    const m = await montarMundo();
    const a = await m.emitirPara('ana@x.com');
    const b = await m.emitirPara('otra@x.com');

    m.colecciones.terceros.docs[0].emails = ['ana@x.co', 'otra@x.com'];

    expect(await m.servicio.resolver(a.token)).toBeNull();
    expect(await m.servicio.resolver(b.token)).not.toBeNull();
  });

  it('SEC: token opens only its own invoice — una dirección con enlaces de dos facturas abre cada una con el suyo', async () => {
    const m = await montarMundo();
    const f2 = {
      ...m.factura,
      _id: oid(),
      numeroCompleto: 'FV-0002',
      paginaEnLote: 1,
    };
    m.colecciones.facturas.insertar(f2);
    m.colecciones.envios.insertar({
      ...m.envio,
      _id: oid(),
      facturaId: f2._id,
    });
    const l1 = await m.emitirPara('ana@x.com');
    const l2 = await m.emitirPara('ana@x.com', 'propietario', {
      facturaId: f2._id,
    });

    const r1 = await m.servicio.resolver(l1.token);
    const r2 = await m.servicio.resolver(l2.token);

    expect(r1?.numeroCompleto).toBe('FV-0001');
    expect(await medidaDePagina(r1!.bytes)).toEqual([300, 300]);
    expect(r2?.numeroCompleto).toBe('FV-0002');
    expect(await medidaDePagina(r2!.bytes)).toEqual([200, 200]);
  });

  it('SEC: token opens only its own invoice — la misma dirección en las partes de dos unidades no abre la factura de la otra', async () => {
    const m = await montarMundo();
    const titular2 = {
      _id: oid(),
      copropiedadId: m.copropiedadId,
      estado: 'active',
      nombre: 'Beto',
      emails: ['ana@x.com'],
    };
    const inmueble2 = {
      _id: oid(),
      copropiedadId: m.copropiedadId,
      estado: 'active',
      titularId: titular2._id,
      arrendatarioId: null,
    };
    const factura2 = {
      ...m.factura,
      _id: oid(),
      inmuebleId: inmueble2._id,
      numeroCompleto: 'FV-0002',
      paginaEnLote: 1,
    };
    m.colecciones.terceros.insertar(titular2);
    m.colecciones.inmuebles.insertar(inmueble2);
    m.colecciones.facturas.insertar(factura2);
    m.colecciones.envios.insertar({
      ...m.envio,
      _id: oid(),
      facturaId: factura2._id,
      inmuebleId: inmueble2._id,
    });
    const { token } = await m.emitirPara('ana@x.com');

    const resultado = await m.servicio.resolver(token);

    expect(resultado?.numeroCompleto).toBe('FV-0001');
  });

  it('SEC: tenant comes from the token row — cada consulta lleva la copropiedad de la fila, sin contexto del cliente', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('ana@x.com');
    const espias = (
      ['facturas', 'envios', 'inmuebles', 'terceros'] as const
    ).flatMap((nombre) =>
      (['find', 'findOne', 'exists'] as const).map((metodo) =>
        jest.spyOn(m.colecciones[nombre], metodo),
      ),
    );
    const espiaCopropiedad = jest.spyOn(
      m.colecciones.copropiedades,
      'findById',
    );

    await m.servicio.resolver(token);

    const llamadas = espias.flatMap((e) => e.mock.calls as unknown[][]);
    expect(llamadas.length).toBeGreaterThanOrEqual(4);
    for (const [filtro] of llamadas) {
      expect(filtro).toMatchObject({ copropiedadId: m.copropiedadId });
    }
    expect(espiaCopropiedad).toHaveBeenCalledWith(m.copropiedadId);
  });
});

describe('EnlaceFacturaService.registrarUso y revocación', () => {
  it('servir dos veces deja usos 2, primerUsoEn en la primera y ultimoUsoEn en la última; una negativa no escribe', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('ana@x.com');

    await m.servicio.resolver(token);
    jest.spyOn(Date, 'now').mockReturnValue(AHORA + 1000);
    await m.servicio.resolver(token);
    const antes = m.colecciones.enlaces.escrituras.length;
    await m.servicio.resolver('hola');
    m.colecciones.facturas.docs[0].estado = 'anulada';
    await m.servicio.resolver(token);

    const [fila] = m.colecciones.enlaces.docs;
    expect(fila.usos).toBe(2);
    expect((fila.primerUsoEn as Date).getTime()).toBe(AHORA);
    expect((fila.ultimoUsoEn as Date).getTime()).toBe(AHORA + 1000);
    expect(m.colecciones.enlaces.escrituras).toHaveLength(antes);
  });

  it('si falla el registro de uso se anota con el id del enlace solamente y el PDF se sirve igual', async () => {
    const m = await montarMundo();
    const { token } = await m.emitirPara('ana@x.com');
    jest.spyOn(m.colecciones.enlaces, 'updateOne').mockImplementation(() => {
      throw new Error(`falló ${token}`);
    });

    const resultado = await m.servicio.resolver(token);

    expect(resultado).not.toBeNull();
    const salida = lineasRegistradas();
    expect(salida).toContain(String(m.colecciones.enlaces.docs[0]._id));
    expect(salida).not.toContain(token);
    expect(salida).not.toContain(sha256(token));
  });

  it('revocarPorId deja ese enlace sin servir y los demás de la factura siguen', async () => {
    const m = await montarMundo();
    const a = await m.emitirPara('ana@x.com');
    const b = await m.emitirPara('otra@x.com');

    await m.servicio.revocarPorId(m.copropiedadId, a.id);

    expect(await m.servicio.resolver(a.token)).toBeNull();
    expect(await m.servicio.resolver(b.token)).not.toBeNull();
  });

  it('revocarPorFactura y revocarPorClave revocan solo lo que nombran', async () => {
    const m = await montarMundo();
    const a = await m.emitirPara('ana@x.com');
    const b = await m.emitirPara('otra@x.com');

    await m.servicio.revocarPorClave(m.copropiedadId, claveCorreo('ana@x.com'));
    expect(await m.servicio.resolver(a.token)).toBeNull();
    expect(await m.servicio.resolver(b.token)).not.toBeNull();

    await m.servicio.revocarPorFactura(m.copropiedadId, m.factura._id);
    expect(await m.servicio.resolver(b.token)).toBeNull();
  });

  it('revocar dos veces conserva el primer revocadoEn', async () => {
    const m = await montarMundo();
    const a = await m.emitirPara('ana@x.com');

    await m.servicio.revocarPorId(m.copropiedadId, a.id);
    const primera = m.colecciones.enlaces.docs[0].revocadoEn as Date;
    jest.spyOn(Date, 'now').mockReturnValue(AHORA + DIA_MS);
    await m.servicio.revocarPorId(m.copropiedadId, a.id);

    expect(m.colecciones.enlaces.docs[0].revocadoEn).toBe(primera);
  });

  it('revocar con la copropiedad equivocada no toca nada', async () => {
    const m = await montarMundo();
    const a = await m.emitirPara('ana@x.com');

    await m.servicio.revocarPorId(oid(), a.id);

    expect(m.colecciones.enlaces.docs[0].revocadoEn).toBeNull();
  });
});
