import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { destinosDeUnidad } from '../../common/directorio/destinos-correo';
import type { ResidenteDeInmueble } from '../../common/directorio/directorio.service';
import { claveCorreo } from '../../common/utils/email.utils';
import { toEnvioFactura } from './envio-facturas.mapper';
import { EnlaceFacturaService } from '../factura-publica/enlace-factura.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { EnvioFacturasProcesoService } from './envio-facturas-proceso.service';
import { MAX_INTENTOS, VIGENCIA_ENVIO_MS } from './envio-facturas.constantes';
import { EnvioFacturasService } from './envio-facturas.service';
import { ColeccionMemoria } from './testing/coleccion-memoria';

const COP = new Types.ObjectId();

const staff = (nombre = 'Ana Contadora'): IRequestUser => ({
  uid: 'uid-staff',
  email: 'ana@ejemplo.com',
  accountId: new Types.ObjectId().toString(),
  nombre,
  copropiedadId: COP.toString(),
});

const residente = (
  rol: 'propietario' | 'arrendatario',
  nombre: string,
): ResidenteDeInmueble => ({
  accountId: new Types.ObjectId().toString(),
  email: `${nombre.toLowerCase().replace(/\s/g, '.')}@ejemplo.com`,
  nombre,
  perfil: 'residente',
  rol,
});

/** One unit with its invoice and the people the directory would find for it. */
interface Unidad {
  codigo: string;
  inmuebleId: Types.ObjectId;
  facturaId: Types.ObjectId;
  residentes: ResidenteDeInmueble[];
}

/** Everything a spec needs, wired with in-memory collections and spies. */
function montar(
  opciones: { correoConfigurado?: boolean; frontendUrl?: string | null } = {},
) {
  const envios = new ColeccionMemoria(['copropiedadId', 'facturaId']);
  const facturas = new ColeccionMemoria();
  const unidades: Unidad[] = [];
  const residentesPorUnidad = new Map<string, ResidenteDeInmueble[]>();
  const partesPorUnidad = new Map<
    string,
    { titular: string[]; arrendatario: string[]; nombres: [string, string] }
  >();
  const titularId = new Types.ObjectId();
  const arrendatarioId = new Types.ObjectId();

  const agregarUnidad = (
    codigo: string,
    residentes: ResidenteDeInmueble[],
    over: Record<string, unknown> = {},
    /** Addresses on the records. By default each account's login is the
     *  address of its party (one address per resident). */
    direcciones: { titular?: string[]; arrendatario?: string[] } = {},
  ): Unidad => {
    const inmuebleId = new Types.ObjectId();
    const facturaId = new Types.ObjectId();
    facturas.insertar({
      _id: facturaId,
      copropiedadId: COP,
      inmuebleId,
      codigoInmueble: codigo,
      numeroCompleto: `FV-${codigo}`,
      estado: 'emitida',
      periodoDesde: new Date('2026-10-01T00:00:00Z'),
      loteId: null,
      ...over,
    });
    residentesPorUnidad.set(inmuebleId.toString(), residentes);
    const delRol = (rol: 'propietario' | 'arrendatario') =>
      residentes.filter((r) => r.rol === rol).map((r) => r.email);
    partesPorUnidad.set(inmuebleId.toString(), {
      titular: direcciones.titular ?? delRol('propietario'),
      arrendatario: direcciones.arrendatario ?? delRol('arrendatario'),
      nombres: [
        residentes.find((r) => r.rol === 'propietario')?.nombre ?? 'Titular',
        residentes.find((r) => r.rol === 'arrendatario')?.nombre ?? 'Inquilino',
      ],
    });
    const unidad = { codigo, inmuebleId, facturaId, residentes };
    unidades.push(unidad);
    return unidad;
  };

  const correo = {
    estaConfigurado: jest.fn(() => opciones.correoConfigurado ?? true),
    enviar: jest.fn((_m: { para: string; asunto: string; html: string }) =>
      Promise.resolve(true),
    ),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(true) };
  const cuentasColeccion = new ColeccionMemoria();
  const enlacesColeccion = new ColeccionMemoria(['tokenHash']);
  const enlaces = new EnlaceFacturaService(
    enlacesColeccion as never,
    ...(Array(7).fill({}) as [never, never, never, never, never, never, never]),
  );
  jest.spyOn(enlaces, 'revocarPorId');
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const directorio = {
    correosDeInmuebles: jest.fn((_cop: Types.ObjectId, ids: Types.ObjectId[]) =>
      Promise.resolve(
        new Map(
          ids.map((id) => {
            const partes = partesPorUnidad.get(id.toString());
            if (!partes) return [id.toString(), []];
            return [
              id.toString(),
              destinosDeUnidad(
                {
                  _id: titularId,
                  nombre: partes.nombres[0],
                  emails: partes.titular,
                },
                {
                  _id: arrendatarioId,
                  nombre: partes.nombres[1],
                  emails: partes.arrendatario,
                },
              ),
            ];
          }),
        ),
      ),
    ),
    residentesDeInmuebles: jest.fn(
      (_cop: Types.ObjectId, ids: Types.ObjectId[]) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id.toString(),
              residentesPorUnidad.get(id.toString()) ?? [],
            ]),
          ),
        ),
    ),
  };
  const tenant = { resolveCoPropertyId: () => COP };
  const frontendUrl =
    opciones.frontendUrl === undefined
      ? 'https://app.ejemplo.com'
      : (opciones.frontendUrl ?? undefined);
  const config = {
    get: (clave: string) =>
      clave === 'app.frontendUrl' ? frontendUrl : undefined,
  };
  const copropiedades = {
    findById: () => ({
      select: () => ({
        exec: () => Promise.resolve({ nombre: 'Torres del Parque' }),
      }),
    }),
  };

  const marcador = new EnvioFacturasService(
    envios as never,
    facturas as never,
    tenant as never,
    auditoria as never,
  );
  const proceso = new EnvioFacturasProcesoService(
    envios as never,
    facturas as never,
    copropiedades as never,
    tenant as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
    auditoria as never,
    config as never,
    cuentasColeccion as never,
  );

  const marcarTodas = () =>
    marcador.marcar(
      { facturaIds: unidades.map((u) => u.facturaId.toString()) },
      staff(),
    );
  const fila = (u: Unidad) =>
    envios.docs.find((d) => String(d.facturaId) === u.facturaId.toString())!;

  return {
    envios,
    cuentasColeccion,
    partes: partesPorUnidad,
    enlacesColeccion,
    titularId,
    arrendatarioId,
    facturas,
    agregarUnidad,
    correo,
    notificaciones,
    enlaces,
    auditoria,
    directorio,
    marcador,
    proceso,
    marcarTodas,
    fila,
  };
}

describe('EnvioFacturasProcesoService', () => {
  it('no envía sin acción explícita', async () => {
    const t = montar();
    t.agregarUnidad('A-101', [residente('propietario', 'Pedro Pérez')]);
    t.agregarUnidad('A-102', [residente('propietario', 'Rosa Ríos')]);

    // Invoices exist but nobody marked them: processing finds nothing to do.
    const sinMarcar = await t.proceso.procesarPendientes(staff());
    expect(sinMarcar.reclamadas).toBe(0);
    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.notificaciones.crear).not.toHaveBeenCalled();

    // Marking only queues: still nothing leaves until someone processes.
    await t.marcarTodas();
    expect(t.envios.docs).toHaveLength(2);
    expect(t.envios.docs.every((d) => d.estado === 'pendiente_envio')).toBe(
      true,
    );
    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.notificaciones.crear).not.toHaveBeenCalled();
    // ...and a marked row is NOT visible to residents yet.
    expect(t.envios.docs.every((d) => d.liberadaEn === undefined)).toBe(true);

    await t.proceso.procesarPendientes(staff());
    expect(t.correo.enviar).toHaveBeenCalledTimes(2);
  });

  it('notifica a propietario y arrendatario', async () => {
    const t = montar();
    const propietario = residente('propietario', 'Pedro Pérez');
    const arrendatario = residente('arrendatario', 'Inés Inquilina');
    const unidad = t.agregarUnidad('A-101', [propietario, arrendatario]);
    await t.marcarTodas();

    const r = await t.proceso.procesarPendientes(staff());

    expect(r).toMatchObject({
      reclamadas: 1,
      enviadas: 1,
      conError: 0,
      correosEnviados: 2,
      pendientes: 0,
      hayMas: false,
    });
    const para = t.correo.enviar.mock.calls.map(([m]) => m.para).sort();
    expect(para).toEqual([arrendatario.email, propietario.email].sort());
    expect(t.notificaciones.crear).toHaveBeenCalledTimes(2);
    expect(t.fila(unidad)).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 2,
      tokenEnvio: null,
    });
    expect(t.fila(unidad).enviadoEn).toBeInstanceOf(Date);
    expect(t.fila(unidad).liberadaEn).toBeInstanceOf(Date);
  });

  it('una notificación interna que no se pudo guardar no se anota y la fila no queda enviada', async () => {
    const t = montar();
    const propietario = residente('propietario', 'Pedro Pérez');
    const unidad = t.agregarUnidad('A-101', [propietario]);
    await t.marcarTodas();
    t.notificaciones.crear.mockResolvedValue(false);

    await t.proceso.procesarPendientes(staff());

    expect(t.fila(unidad).notificadosIds ?? []).toEqual([]);
    expect(t.fila(unidad).estado).not.toBe('enviado');
  });

  it('inmueble sin arrendatario no falla', async () => {
    const t = montar();
    const soloPropietario = residente('propietario', 'Pedro Pérez');
    const conAmbos = [
      residente('propietario', 'Rosa Ríos'),
      residente('arrendatario', 'Inés Inquilina'),
    ];
    const a = t.agregarUnidad('A-101', [soloPropietario]);
    const b = t.agregarUnidad('A-102', conAmbos);
    const nadie = t.agregarUnidad('A-103', []);
    await t.marcarTodas();

    const r = await t.proceso.procesarPendientes(staff());

    // The unit with no tenant was sent to its owner; the unit with nobody
    // reachable is reported and parked, and neither stopped the others.
    expect(t.fila(a)).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 1,
    });
    expect(t.fila(b)).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 2,
    });
    expect(t.fila(nadie)).toMatchObject({
      estado: 'error',
      ultimoError: 'sin_destinatarios',
    });
    expect(r).toMatchObject({
      reclamadas: 3,
      enviadas: 2,
      conError: 1,
      correosEnviados: 3,
      unidadesSinDestinatario: ['A-103'],
    });
  });

  it('el correo lleva el enlace personal al PDF, no adjunta la factura ni muestra montos, y no lleva enlace de sesión', async () => {
    const t = montar();
    t.agregarUnidad('A-101', [residente('propietario', 'Pedro <b>Pérez</b>')]);
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    const [mensaje] = t.correo.enviar.mock.calls[0];
    expect(mensaje).not.toHaveProperty('adjuntos');
    expect(mensaje.asunto).toBe('Tu factura FV-A-101 ya está disponible');
    expect(mensaje.html).toContain('FV-A-101');
    expect(mensaje.html).toMatch(
      /https:\/\/app\.ejemplo\.com\/factura#[0-9a-f]{64}/,
    );
    expect(mensaje.html).not.toContain('/auth/enlace');
    expect(mensaje.html).toContain('octubre de 2026');
    expect(mensaje.html).not.toContain('<b>Pérez</b>'); // names are escaped
    expect(mensaje.html).not.toMatch(/\$|total|saldo/i);
  });

  describe('reintento tras corte no duplica', () => {
    it('si un destinatario falla, el reintento solo alcanza al que faltaba', async () => {
      const t = montar();
      const propietario = residente('propietario', 'Pedro Pérez');
      const arrendatario = residente('arrendatario', 'Inés Inquilina');
      const unidad = t.agregarUnidad('A-101', [propietario, arrendatario]);
      await t.marcarTodas();
      // The provider refuses the tenant's address on the first run.
      t.correo.enviar.mockImplementation((m) =>
        Promise.resolve(m.para !== arrendatario.email),
      );

      const primera = await t.proceso.procesarPendientes(staff());
      expect(primera).toMatchObject({ reintentables: 1, enviadas: 0 });
      expect(t.fila(unidad)).toMatchObject({
        estado: 'pendiente_envio',
        intentos: 1,
      });
      // Waiting out the backoff: not claimable yet, so the screen stops looping.
      expect(primera.hayMas).toBe(false);
      expect(primera.enCurso).toBe(0);
      expect(primera.enEspera).toBe(1);

      // Backoff over, provider healthy again.
      t.fila(unidad).proximoIntentoEn = new Date(Date.now() - 1000);
      t.correo.enviar.mockClear();
      t.correo.enviar.mockResolvedValue(true);
      t.notificaciones.crear.mockClear();

      const segunda = await t.proceso.procesarPendientes(staff());

      expect(segunda).toMatchObject({ enviadas: 1, correosEnviados: 1 });
      // The owner was NOT written to again: only the missing tenant.
      expect(t.correo.enviar).toHaveBeenCalledTimes(1);
      expect(t.correo.enviar.mock.calls[0][0].para).toBe(arrendatario.email);
      expect(t.notificaciones.crear).not.toHaveBeenCalled();
      expect(t.fila(unidad)).toMatchObject({ estado: 'enviado' });
    });

    it('una solicitud cortada a medias (candado vencido) se completa sin repetir lo ya enviado', async () => {
      const t = montar();
      const propietario = residente('propietario', 'Pedro Pérez');
      const arrendatario = residente('arrendatario', 'Inés Inquilina');
      const unidad = t.agregarUnidad('A-101', [propietario, arrendatario]);
      await t.marcarTodas();
      // The previous request died after reaching the owner: it left its lease
      // behind (long expired) and the owner already recorded.
      const fila = t.fila(unidad);
      fila.tokenEnvio = 'corrida-muerta';
      fila.envioIniciadoEn = new Date(Date.now() - VIGENCIA_ENVIO_MS - 1000);
      fila.liberadaEn = new Date(Date.now() - VIGENCIA_ENVIO_MS - 1000);
      fila.notificadosIds = [new Types.ObjectId(propietario.accountId)];
      fila.correosEntregados = [
        {
          clave: claveCorreo(propietario.email),
          rol: 'propietario',
          terceroId: t.titularId,
          aceptadoEn: new Date(),
        },
      ];

      const r = await t.proceso.procesarPendientes(staff());

      expect(r).toMatchObject({
        reclamadas: 1,
        enviadas: 1,
        correosEnviados: 1,
      });
      expect(t.correo.enviar).toHaveBeenCalledTimes(1);
      expect(t.correo.enviar.mock.calls[0][0].para).toBe(arrendatario.email);
      expect(fila.correosEntregados).toHaveLength(2);
    });

    it('un candado vivo de otra corrida no se pisa: la fila se deja en paz', async () => {
      const t = montar();
      const unidad = t.agregarUnidad('A-101', [
        residente('propietario', 'Pedro Pérez'),
      ]);
      await t.marcarTodas();
      const fila = t.fila(unidad);
      fila.tokenEnvio = 'corrida-viva';
      fila.envioIniciadoEn = new Date();

      const r = await t.proceso.procesarPendientes(staff());

      expect(r).toMatchObject({
        reclamadas: 0,
        hayMas: false,
        enCurso: 1,
        enEspera: 0,
      });
      expect(t.correo.enviar).not.toHaveBeenCalled();
      expect(fila.tokenEnvio).toBe('corrida-viva');
    });

    it('si el proceso se cae a mitad, suelta el candado y reintenta al volver a llamar', async () => {
      const t = montar();
      const unidad = t.agregarUnidad('A-101', [
        residente('propietario', 'Pedro Pérez'),
      ]);
      await t.marcarTodas();
      t.directorio.residentesDeInmuebles.mockRejectedValueOnce(
        new Error('mongo cortó'),
      );

      await expect(t.proceso.procesarPendientes(staff())).rejects.toThrow(
        'mongo cortó',
      );
      expect(t.fila(unidad)).toMatchObject({
        estado: 'pendiente_envio',
        tokenEnvio: null,
      });
      expect(t.correo.enviar).not.toHaveBeenCalled();

      const r = await t.proceso.procesarPendientes(staff());
      expect(r).toMatchObject({ enviadas: 1, correosEnviados: 1 });
    });
  });

  it('dos procesadores simultáneos no envían dos veces', async () => {
    const t = montar();
    const personas: ResidenteDeInmueble[] = [];
    for (let i = 0; i < 24; i += 1) {
      const p = residente('propietario', `Propietario ${i}`);
      const a = residente('arrendatario', `Arrendatario ${i}`);
      personas.push(p, a);
      t.agregarUnidad(`A-${100 + i}`, [p, a]);
    }
    await t.marcarTodas();
    // Adversarial order: the second processor writes its claim only after the
    // first one finished claiming (both picked the same candidates before).
    t.envios.retrasoUpdateMany = [0, 12];

    const [uno, dos] = await Promise.all([
      t.proceso.procesarPendientes(staff('Ana')),
      t.proceso.procesarPendientes(staff('Beto')),
    ]);

    // Disjoint slices: together they covered the queue exactly once.
    expect(uno.reclamadas + dos.reclamadas).toBe(24);
    expect(uno.enviadas + dos.enviadas).toBe(24);
    const enviadosA = t.correo.enviar.mock.calls.map(([m]) => m.para);
    expect(enviadosA).toHaveLength(48);
    expect(new Set(enviadosA).size).toBe(48);
    expect(t.notificaciones.crear).toHaveBeenCalledTimes(48);
    expect(t.envios.docs.every((d) => d.estado === 'enviado')).toBe(true);
    // Each row records which of the two processors handled it.
    const procesadores = new Set(
      t.envios.docs.map((d) => d.procesadoPorNombre),
    );
    expect(procesadores.size).toBeGreaterThan(0);
  });

  it('mientras un procesador está enviando, otro no toma esas filas ni las duplica', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [
      residente('propietario', 'Pedro Pérez'),
    ]);
    await t.marcarTodas();
    // The first processor stalls inside the provider call, holding its lease.
    let soltarCorreo!: () => void;
    const compuerta = new Promise<void>((resolver) => {
      soltarCorreo = resolver;
    });
    t.correo.enviar.mockImplementation(async () => {
      await compuerta;
      return true;
    });
    const primero = t.proceso.procesarPendientes(staff('Ana'));
    while (t.correo.enviar.mock.calls.length === 0) {
      await new Promise((r) => setImmediate(r));
    }

    const segundo = await t.proceso.procesarPendientes(staff('Beto'));

    expect(segundo).toMatchObject({
      reclamadas: 0,
      hayMas: false,
      enCurso: 1,
      enEspera: 0,
    });
    soltarCorreo();
    await primero;
    expect(t.correo.enviar).toHaveBeenCalledTimes(1);
    expect(t.fila(unidad)).toMatchObject({
      estado: 'enviado',
      procesadoPorNombre: 'Ana',
    });
  });

  it('la misma cola procesada dos veces seguidas no reenvía nada', async () => {
    const t = montar();
    t.agregarUnidad('A-101', [residente('propietario', 'Pedro Pérez')]);
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());
    const otra = await t.proceso.procesarPendientes(staff());

    expect(otra.reclamadas).toBe(0);
    expect(t.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('sin correo configurado responde 409 y no toca ninguna fila', async () => {
    const t = montar({ correoConfigurado: false });
    const unidad = t.agregarUnidad('A-101', [
      residente('propietario', 'Pedro Pérez'),
    ]);
    await t.marcarTodas();

    await expect(t.proceso.procesarPendientes(staff())).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(t.fila(unidad)).toMatchObject({
      estado: 'pendiente_envio',
      tokenEnvio: null,
    });
    expect(t.fila(unidad).liberadaEn).toBeUndefined();
    expect(t.notificaciones.crear).not.toHaveBeenCalled();
    expect(t.auditoria.registrar).not.toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'enviar' }),
    );
  });

  describe('FRONTEND_URL es obligatoria para enviar', () => {
    const MENSAJE_FALTA =
      'No se puede enviar: falta configurar FRONTEND_URL, la dirección pública de la aplicación, con la que se arman los enlaces de las facturas.';
    const MENSAJE_MALFORMADA =
      'No se puede enviar: FRONTEND_URL debe ser solo la dirección pública (esquema y dominio, sin ruta ni parámetros).';

    async function intentar(frontendUrl: string | null) {
      const t = montar({ frontendUrl });
      const unidad = t.agregarUnidad('A-101', [
        residente('propietario', 'Pedro Pérez'),
      ]);
      await t.marcarTodas();
      const error = await t.proceso.procesarPendientes(staff()).then(
        () => null,
        (e: unknown) => e,
      );
      return { t, unidad, error };
    }

    it.each([
      ['sin FRONTEND_URL', null, MENSAJE_FALTA],
      ['con una ruta', 'https://app.ejemplo.com/app', MENSAJE_MALFORMADA],
      ['con parámetros', 'https://app.ejemplo.com/?a=1', MENSAJE_MALFORMADA],
      ['con un fragmento', 'https://app.ejemplo.com/#x', MENSAJE_MALFORMADA],
      [
        'con credenciales',
        'https://usuario:clave@app.ejemplo.com',
        MENSAJE_MALFORMADA,
      ],
    ])(
      'SEC: 409 body never echoes configuration — %s responde 409 antes de reclamar y de auditar',
      async (_n, valor, mensaje) => {
        const { t, unidad, error } = await intentar(valor);

        expect(error).toBeInstanceOf(ConflictException);
        const cuerpo = JSON.stringify(
          (error as ConflictException).getResponse(),
        );
        expect(cuerpo).toContain(mensaje);
        expect(cuerpo).not.toContain('ejemplo.com');
        expect(cuerpo).not.toContain('clave');
        expect(t.fila(unidad)).toMatchObject({
          estado: 'pendiente_envio',
          tokenEnvio: null,
        });
        expect(t.fila(unidad).liberadaEn).toBeUndefined();
        expect(t.auditoria.registrar).not.toHaveBeenCalledWith(
          expect.objectContaining({ accion: 'enviar' }),
        );
        expect(t.correo.enviar).not.toHaveBeenCalled();
      },
    );

    it('SEC: 409 body never echoes configuration — el 409 de SendGrid se evalúa primero y no cambia', async () => {
      const t = montar({ correoConfigurado: false, frontendUrl: null });

      const error = await t.proceso.procesarPendientes(staff()).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(
        JSON.stringify((error as ConflictException).getResponse()),
      ).toContain('El correo no está configurado en este entorno');
    });

    it('con correo y un origen válido procesa con normalidad', async () => {
      const { t, error } = await intentar('https://app.ejemplo.com');

      expect(error).toBeNull();
      expect(t.correo.enviar).toHaveBeenCalledTimes(1);
    });
  });

  it('una factura anulada después de marcarla no se envía y queda en error', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [
      residente('propietario', 'Pedro Pérez'),
    ]);
    await t.marcarTodas();
    t.facturas.docs[0].estado = 'anulada';

    const r = await t.proceso.procesarPendientes(staff());

    expect(r).toMatchObject({ conError: 1, enviadas: 0 });
    expect(t.fila(unidad)).toMatchObject({
      estado: 'error',
      ultimoError: 'factura_anulada',
    });
    expect(t.correo.enviar).not.toHaveBeenCalled();
  });

  it('tras agotar los reintentos la fila pasa a error y se vuelve a encolar solo marcándola otra vez', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [
      residente('propietario', 'Pedro Pérez'),
    ]);
    await t.marcarTodas();
    t.correo.enviar.mockResolvedValue(false);

    for (let i = 0; i < MAX_INTENTOS; i += 1) {
      t.fila(unidad).proximoIntentoEn = null;
      await t.proceso.procesarPendientes(staff());
    }

    expect(t.fila(unidad)).toMatchObject({
      estado: 'error',
      ultimoError: 'reintentos_agotados',
      intentos: MAX_INTENTOS,
    });
    expect((await t.proceso.procesarPendientes(staff())).reclamadas).toBe(0);

    // Explicit retry: marking again re-queues it and resets the counter.
    t.correo.enviar.mockResolvedValue(true);
    const remarcado = await t.marcarTodas();
    expect(remarcado.marcadas).toBe(1);
    expect(t.fila(unidad)).toMatchObject({
      estado: 'pendiente_envio',
      intentos: 0,
    });
    const r = await t.proceso.procesarPendientes(staff());
    expect(r.enviadas).toBe(1);
  });

  it('deja constancia de quién envía antes de que salga el primer correo', async () => {
    const t = montar();
    t.agregarUnidad('A-101', [residente('propietario', 'Pedro Pérez')]);
    await t.marcarTodas();
    const orden: string[] = [];
    t.auditoria.registrar.mockImplementation((e: { accion: string }) => {
      orden.push(`auditoria:${e.accion}`);
      return Promise.resolve();
    });
    t.correo.enviar.mockImplementation(() => {
      orden.push('correo');
      return Promise.resolve(true);
    });
    const usuario = staff('Ana Contadora');

    await t.proceso.procesarPendientes(usuario);

    expect(orden).toEqual(['auditoria:enviar', 'correo']);
    expect(t.auditoria.registrar).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actorAccountId: usuario.accountId,
        actorNombre: 'Ana Contadora',
        accion: 'enviar',
        entidadTipo: 'envio-factura',
      }),
    );
    expect(t.envios.docs[0]).toMatchObject({
      procesadoPorNombre: 'Ana Contadora',
    });
    expect(String(t.envios.docs[0].procesadoPorId)).toBe(usuario.accountId);
  });

  it('si la auditoría falla no sale nada y las filas quedan libres', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [
      residente('propietario', 'Pedro Pérez'),
    ]);
    await t.marcarTodas();
    t.auditoria.registrar.mockRejectedValueOnce(new Error('auditoría caída'));

    await expect(t.proceso.procesarPendientes(staff())).rejects.toThrow(
      'auditoría caída',
    );

    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.fila(unidad)).toMatchObject({
      estado: 'pendiente_envio',
      tokenEnvio: null,
    });
  });

  it('una sesión sin cuenta local no puede procesar (403)', async () => {
    const t = montar();
    t.agregarUnidad('A-101', [residente('propietario', 'Pedro Pérez')]);
    await t.marcarTodas();

    await expect(
      t.proceso.procesarPendientes({ uid: 'u', email: 'x@y.com' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.correo.enviar).not.toHaveBeenCalled();
  });

  it('un residente que también es el mismo en dos roles recibe un solo aviso', async () => {
    const t = montar();
    const mismo = residente('propietario', 'Pedro Pérez');
    t.agregarUnidad('A-101', [mismo, { ...mismo, rol: 'arrendatario' }]);
    await t.marcarTodas();

    const r = await t.proceso.procesarPendientes(staff());

    expect(r.correosEnviados).toBe(1);
    expect(t.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('procesa por tandas y deja constancia de cuántas filas tomó', async () => {
    const t = montar();
    for (let i = 0; i < 55; i += 1) {
      t.agregarUnidad(`B-${i}`, [residente('propietario', `Dueño ${i}`)]);
    }
    await t.marcarTodas();

    const primera = await t.proceso.procesarPendientes(staff());
    expect(primera).toMatchObject({
      reclamadas: 50,
      enviadas: 50,
      pendientes: 5,
      hayMas: true,
    });
    const segunda = await t.proceso.procesarPendientes(staff());
    expect(segunda).toMatchObject({
      reclamadas: 5,
      enviadas: 5,
      pendientes: 0,
      hayMas: false,
    });
  });
  it('una factura anulada después de marcarla no se libera al portal', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [
      residente('propietario', 'Pedro Pérez'),
    ]);
    await t.marcarTodas();
    t.facturas.docs[0].estado = 'anulada';

    await t.proceso.procesarPendientes(staff());

    expect(t.fila(unidad).ultimoError).toBe('factura_anulada');
    // Never stamped: the owner does not see a voided invoice nobody sent.
    expect(t.fila(unidad).liberadaEn).toBeUndefined();
  });

  it('antes de cada tanda vuelve a comprobar qué filas sigue teniendo: no envía a las que otro procesador tomó', async () => {
    const t = montar();
    const unidades = Array.from({ length: 20 }, (_, i) =>
      t.agregarUnidad(`C-${i}`, [residente('propietario', `Dueño C${i}`)]),
    );
    await t.marcarTodas();
    // The first batch stalls in the provider long enough for the lease to
    // expire; another processor then takes PART of the remaining rows.
    let soltarCorreo!: () => void;
    const compuerta = new Promise<void>((resolver) => {
      soltarCorreo = resolver;
    });
    t.correo.enviar.mockImplementationOnce(async () => {
      await compuerta;
      return true;
    });
    const corrida = t.proceso.procesarPendientes(staff('Ana'));
    while (t.correo.enviar.mock.calls.length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const robadas = unidades.slice(15).map((u) => t.fila(u));
    for (const fila of robadas) fila.tokenEnvio = 'otro-procesador';
    soltarCorreo();
    await corrida;

    const para = new Set(t.correo.enviar.mock.calls.map(([m]) => m.para));
    for (const u of unidades.slice(15)) {
      expect(para.has(u.residentes[0].email)).toBe(false);
    }
    for (const u of unidades.slice(0, 15)) {
      expect(para.has(u.residentes[0].email)).toBe(true);
    }
    // The rows the other processor holds are left exactly as it has them.
    expect(robadas.every((f) => f.tokenEnvio === 'otro-procesador')).toBe(true);
  });
});

describe('EnvioFacturasProcesoService — por dirección de la ficha', () => {
  type Montaje = ReturnType<typeof montar>;
  const TOKEN_EN_HTML = /\/factura#([0-9a-f]{64})/;
  const tokenDe = (html: string): string => TOKEN_EN_HTML.exec(html)![1];
  const destinatarios = (t: Montaje) =>
    t.correo.enviar.mock.calls.map(([m]) => m.para);

  let registros: jest.SpyInstance[];
  const todoLoRegistrado = () =>
    registros
      .flatMap((r) => r.mock.calls as unknown[][])
      .map((c) => JSON.stringify(c))
      .join('\n');

  beforeEach(() => {
    registros = (['error', 'warn', 'log', 'debug', 'verbose'] as const).map(
      (n) => jest.spyOn(Logger.prototype, n).mockImplementation(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('3 direcciones del titular y 1 del arrendatario, sin cuentas: 4 correos, 4 entradas, fila enviada', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [],
      {},
      {
        titular: ['t1@x.com', 't2@x.com', 't3@x.com'],
        arrendatario: ['a1@x.com'],
      },
    );
    await t.marcarTodas();

    const r = await t.proceso.procesarPendientes(staff());

    expect(r).toMatchObject({
      reclamadas: 1,
      enviadas: 1,
      correosEnviados: 4,
      conError: 0,
    });
    expect(destinatarios(t).sort()).toEqual(
      ['a1@x.com', 't1@x.com', 't2@x.com', 't3@x.com'].sort(),
    );
    expect(t.fila(unidad)).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 4,
    });
    expect(t.fila(unidad).correosEntregados).toHaveLength(4);
    expect(
      (t.fila(unidad).correosEntregados as { rol: string }[])
        .map((e) => e.rol)
        .sort(),
    ).toEqual(['arrendatario', 'propietario', 'propietario', 'propietario']);
  });

  it('la entrada guardada lleva clave, rol, tercero y fecha, y ningún campo con la dirección', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: ['Ana@X.com'] });
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    const [entrada] = t.fila(unidad).correosEntregados as Record<
      string,
      unknown
    >[];
    expect(entrada).toMatchObject({
      clave: claveCorreo('ana@x.com'),
      rol: 'propietario',
      terceroId: t.titularId,
    });
    expect(entrada.aceptadoEn).toBeInstanceOf(Date);
    expect(JSON.stringify(entrada).toLowerCase()).not.toContain('ana@x.com');
  });

  it('si el proveedor rechaza 1 de 4: 3 entradas, sigue pendiente con backoff, y el reintento solo manda la que falta', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [],
      {},
      {
        titular: ['t1@x.com', 't2@x.com', 't3@x.com'],
        arrendatario: ['a1@x.com'],
      },
    );
    await t.marcarTodas();
    t.correo.enviar.mockImplementation((m) =>
      Promise.resolve(m.para !== 't2@x.com'),
    );

    const primera = await t.proceso.procesarPendientes(staff());

    expect(primera).toMatchObject({ reintentables: 1, correosEnviados: 3 });
    expect(t.fila(unidad)).toMatchObject({
      estado: 'pendiente_envio',
      intentos: 1,
    });
    expect(t.fila(unidad).correosEntregados).toHaveLength(3);
    expect((t.fila(unidad).proximoIntentoEn as Date).getTime()).toBeGreaterThan(
      Date.now(),
    );

    t.fila(unidad).proximoIntentoEn = null;
    t.correo.enviar.mockClear();
    t.correo.enviar.mockResolvedValue(true);
    const segunda = await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t)).toEqual(['t2@x.com']);
    expect(segunda).toMatchObject({ enviadas: 1, correosEnviados: 1 });
    expect(t.fila(unidad).correosEntregados).toHaveLength(4);
  });

  it('una notificación interna que falla no frena los correos, pero la fila no queda enviada', async () => {
    const t = montar();
    const cuenta = residente('propietario', 'Pedro Pérez');
    const unidad = t.agregarUnidad(
      'A-101',
      [cuenta],
      {},
      { titular: ['a@x.com', 'b@x.com'] },
    );
    await t.marcarTodas();
    t.notificaciones.crear.mockResolvedValue(false);

    await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t).sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(t.fila(unidad).correosEntregados).toHaveLength(2);
    expect(t.fila(unidad).estado).not.toBe('enviado');
  });

  it('una cuenta y 2 direcciones: 1 aviso interno, 2 correos, y el correo de acceso de la cuenta no recibe nada', async () => {
    const t = montar();
    const cuenta = residente('propietario', 'Pedro Pérez');
    t.agregarUnidad(
      'A-101',
      [cuenta],
      {},
      { titular: ['uno@x.com', 'dos@x.com'] },
    );
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    expect(t.notificaciones.crear).toHaveBeenCalledTimes(1);
    expect(destinatarios(t).sort()).toEqual(['dos@x.com', 'uno@x.com']);
    expect(destinatarios(t)).not.toContain(cuenta.email);
  });

  it('una cuenta con las llaves de Finanzas igual recibe el PDF en las direcciones de la ficha', async () => {
    const t = montar();
    const cuenta: ResidenteDeInmueble = {
      ...residente('propietario', 'Pedro Pérez'),
      perfil: 'personal',
    };
    t.agregarUnidad('A-101', [cuenta], {}, { titular: ['ficha@x.com'] });
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t)).toEqual(['ficha@x.com']);
    expect(t.correo.enviar.mock.calls[0][0].html).toMatch(TOKEN_EN_HTML);
  });

  it('sin ninguna dirección y con una cuenta: error sin_destinatarios, la unidad se reporta y el aviso interno se crea una vez', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [residente('propietario', 'Pedro Pérez')],
      {},
      { titular: [] },
    );
    await t.marcarTodas();

    const r = await t.proceso.procesarPendientes(staff());

    expect(r).toMatchObject({
      conError: 1,
      enviadas: 0,
      unidadesSinDestinatario: ['A-101'],
    });
    expect(t.fila(unidad)).toMatchObject({
      estado: 'error',
      ultimoError: 'sin_destinatarios',
    });
    expect(t.notificaciones.crear).toHaveBeenCalledTimes(1);
    expect(t.correo.enviar).not.toHaveBeenCalled();
  });

  it('sin dirección ni cuenta: error sin_destinatarios y no sale nada', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: [] });
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    expect(t.fila(unidad).ultimoError).toBe('sin_destinatarios');
    expect(t.notificaciones.crear).not.toHaveBeenCalled();
    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.enlacesColeccion.docs).toHaveLength(0);
  });

  it('se agrega una dirección y se vuelve a marcar: se envía y el aviso interno anterior no se repite', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [residente('propietario', 'Pedro Pérez')],
      {},
      { titular: [] },
    );
    await t.marcarTodas();
    await t.proceso.procesarPendientes(staff());
    expect(t.fila(unidad).ultimoError).toBe('sin_destinatarios');
    t.partes.get(unidad.inmuebleId.toString())!.titular = ['nueva@x.com'];

    await t.marcarTodas();
    const r = await t.proceso.procesarPendientes(staff());

    expect(r.enviadas).toBe(1);
    expect(destinatarios(t)).toEqual(['nueva@x.com']);
    expect(t.fila(unidad).estado).toBe('enviado');
    expect(t.notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('una dirección agregada DESPUÉS de enviada la fila no envía nada (reenviar es otro paquete)', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: ['a@x.com'] });
    await t.marcarTodas();
    await t.proceso.procesarPendientes(staff());
    t.correo.enviar.mockClear();
    t.partes.get(unidad.inmuebleId.toString())!.titular.push('b@x.com');

    const r = await t.proceso.procesarPendientes(staff());

    expect(r.reclamadas).toBe(0);
    expect(t.correo.enviar).not.toHaveBeenCalled();
  });

  it('una dirección quitada de la ficha antes del intento no se envía', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [],
      {},
      { titular: ['a@x.com', 'b@x.com'] },
    );
    await t.marcarTodas();
    t.partes.get(unidad.inmuebleId.toString())!.titular = ['a@x.com'];

    await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t)).toEqual(['a@x.com']);
    expect(t.fila(unidad).destinatariosTotal).toBe(1);
  });

  it('la misma dirección en titular y arrendatario: un solo correo y una sola entrada, la del propietario', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [],
      {},
      { titular: ['c@x.com'], arrendatario: ['C@X.com'] },
    );
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t)).toEqual(['c@x.com']);
    expect(t.fila(unidad).correosEntregados).toMatchObject([
      { rol: 'propietario', terceroId: t.titularId },
    ]);
  });

  it('una solicitud cortada tras 2 de 4 correos: la siguiente llamada manda exactamente los otros 2 y cierra', async () => {
    const t = montar();
    const direcciones = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'];
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: direcciones });
    await t.marcarTodas();
    const fila = t.fila(unidad);
    fila.tokenEnvio = 'corrida-muerta';
    fila.envioIniciadoEn = new Date(Date.now() - VIGENCIA_ENVIO_MS - 1000);
    fila.correosEntregados = direcciones.slice(0, 2).map((d) => ({
      clave: claveCorreo(d),
      rol: 'propietario',
      terceroId: t.titularId,
      aceptadoEn: new Date(),
    }));

    const r = await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t).sort()).toEqual(['c@x.com', 'd@x.com']);
    expect(r).toMatchObject({ enviadas: 1, correosEnviados: 2 });
    expect(fila.correosEntregados).toHaveLength(4);
    expect(fila.estado).toBe('enviado');
  });

  it('una factura anulada no genera correo ni enlace', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: ['a@x.com'] });
    await t.marcarTodas();
    t.facturas.docs[0].estado = 'anulada';

    await t.proceso.procesarPendientes(staff());

    expect(t.fila(unidad).ultimoError).toBe('factura_anulada');
    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.enlacesColeccion.docs).toHaveLength(0);
  });

  it('SEC: no duplicate entry per clave under concurrency — si otro procesador ya registró la dirección mientras este esperaba al proveedor, el push condicional no duplica', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: ['a@x.com'] });
    await t.marcarTodas();
    let soltar!: () => void;
    const compuerta = new Promise<void>((resolver) => {
      soltar = resolver;
    });
    t.correo.enviar.mockImplementation(async () => {
      await compuerta;
      return true;
    });
    const corrida = t.proceso.procesarPendientes(staff('Ana'));
    while (t.correo.enviar.mock.calls.length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    // The other processor's acceptance of the same address lands first.
    (t.fila(unidad).correosEntregados as unknown[]).push({
      clave: claveCorreo('a@x.com'),
      rol: 'propietario',
      terceroId: t.titularId,
      aceptadoEn: new Date(),
    });

    soltar();
    await corrida;

    expect(t.fila(unidad).correosEntregados).toHaveLength(1);
  });

  it('SEC: one token per (invoice, address) — cada correo va a UNA dirección y lleva un token distinto, con su propio registro', async () => {
    const t = montar();
    t.agregarUnidad(
      'A-101',
      [],
      {},
      { titular: ['a@x.com', 'b@x.com'], arrendatario: ['c@x.com'] },
    );
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    const mensajes = t.correo.enviar.mock.calls.map(([m]) => m);
    expect(mensajes.map((m) => m.para).sort()).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
    for (const m of mensajes) expect(m.para).not.toMatch(/[,;\s]/);
    const tokens = mensajes.map((m) => tokenDe(m.html));
    expect(new Set(tokens).size).toBe(3);
    expect(t.enlacesColeccion.docs).toHaveLength(3);
    expect(
      new Set(t.enlacesColeccion.docs.map((d) => String(d.clave))).size,
    ).toBe(3);
    const volcado = JSON.stringify(t.enlacesColeccion.docs);
    for (const token of tokens) expect(volcado).not.toContain(token);
  });

  it('un correo que el proveedor rechaza revoca su enlace y no deja entrada', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: ['a@x.com'] });
    await t.marcarTodas();
    t.correo.enviar.mockResolvedValue(false);

    await t.proceso.procesarPendientes(staff());

    expect(t.fila(unidad).correosEntregados).toEqual([]);
    expect(t.enlacesColeccion.docs).toHaveLength(1);
    expect(t.enlacesColeccion.docs[0].revocadoEn).toBeInstanceOf(Date);
  });

  it('si no se puede crear el enlace, no sale el correo, la fila se reintenta y el registro solo nombra la fila', async () => {
    const t = montar();
    const unidad = t.agregarUnidad('A-101', [], {}, { titular: ['a@x.com'] });
    await t.marcarTodas();
    jest
      .spyOn(t.enlacesColeccion, 'findOneAndUpdate')
      .mockImplementation(() => {
        throw new Error('E11000 dup key { tokenHash: "abc" }');
      });

    const r = await t.proceso.procesarPendientes(staff());

    expect(r).toMatchObject({ reintentables: 1, enviadas: 0 });
    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.fila(unidad).estado).toBe('pendiente_envio');
    const salida = todoLoRegistrado();
    expect(salida).toContain(String(t.fila(unidad)._id));
    expect(salida).not.toContain('a@x.com');
    expect(salida).not.toContain('tokenHash');
  });

  it('SEC: processor logs carry no token or address — ni en éxito, ni con un correo rechazado', async () => {
    const t = montar();
    t.agregarUnidad(
      'A-101',
      [residente('propietario', 'Pedro Pérez')],
      {},
      { titular: ['uno@x.com', 'dos@x.com'], arrendatario: ['tres@x.com'] },
    );
    await t.marcarTodas();
    t.correo.enviar.mockImplementation((m) =>
      Promise.resolve(m.para !== 'dos@x.com'),
    );

    await t.proceso.procesarPendientes(staff());

    const tokens = t.correo.enviar.mock.calls.map(([m]) => tokenDe(m.html));
    const salida = todoLoRegistrado();
    for (const token of tokens) {
      expect(salida).not.toContain(token);
      expect(salida).not.toContain(
        createHash('sha256').update(token).digest('hex'),
      );
    }
    for (const dir of ['uno@x.com', 'dos@x.com', 'tres@x.com']) {
      expect(salida).not.toContain(dir);
    }
    expect(salida).not.toContain(claveCorreo('dos@x.com'));
  });

  it('SEC: el catch general de una fila registra solo la clase del error, nunca su mensaje', async () => {
    const t = montar();
    const unidad = t.agregarUnidad(
      'A-101',
      [],
      {},
      { titular: ['secreta@x.com'] },
    );
    await t.marcarTodas();
    // A provider message may echo the address it refused.
    jest
      .spyOn(
        t.proceso as unknown as { cerrarEnviada: () => Promise<void> },
        'cerrarEnviada',
      )
      .mockRejectedValue(new TypeError('rechazado: secreta@x.com'));

    const r = await t.proceso.procesarPendientes(staff());

    expect(r).toMatchObject({ enviadas: 0 });
    const salida = todoLoRegistrado();
    expect(salida).toContain('TypeError');
    expect(salida).toContain(String(t.fila(unidad)._id));
    expect(salida).not.toContain('rechazado');
    expect(salida).not.toContain('secreta@x.com');
  });
});

describe('EnvioFacturasProcesoService — filas a medias del código anterior (puente heredado)', () => {
  type Montaje = ReturnType<typeof montar>;
  const destinatarios = (t: Montaje) =>
    t.correo.enviar.mock.calls.map(([m]) => m.para);

  /** A row the previous release left half-sent: its owner ACCOUNT was e-mailed. */
  async function filaHeredada(
    t: Montaje,
    opciones: { loginDeLaCuenta: string; titular: string[] },
  ) {
    const cuenta = residente('propietario', 'Pedro Pérez');
    const unidad = t.agregarUnidad(
      'A-101',
      [{ ...cuenta, email: opciones.loginDeLaCuenta }],
      {},
      { titular: opciones.titular },
    );
    t.cuentasColeccion.insertar({
      _id: new Types.ObjectId(cuenta.accountId),
      email: opciones.loginDeLaCuenta,
    });
    await t.marcarTodas();
    const fila = t.fila(unidad);
    fila.notificadosIds = [new Types.ObjectId(cuenta.accountId)];
    fila.correosEnviadosIds = [new Types.ObjectId(cuenta.accountId)];
    return { unidad, fila };
  }

  it('la dirección que ya recibió la cuenta antigua no se repite: solo se envía la otra y la fila cierra', async () => {
    const t = montar();
    const { unidad, fila } = await filaHeredada(t, {
      loginDeLaCuenta: 'a@x.com',
      titular: ['a@x.com', 'b@x.com'],
    });

    const r = await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t)).toEqual(['b@x.com']);
    expect(r).toMatchObject({ enviadas: 1, correosEnviados: 1 });
    expect(fila.estado).toBe('enviado');
    expect(fila.destinatariosTotal).toBe(2);
    expect(fila.correosEntregados).toHaveLength(2);
    expect(toEnvioFactura(fila as never).correosAceptados).toBe(2);
    expect(t.notificaciones.crear).not.toHaveBeenCalled();
    expect(t.fila(unidad).correosEnviadosIds).toHaveLength(1);
  });

  it('si el correo de acceso de la cuenta NO está en la ficha, no hay equivalencia: se envía a todas las direcciones', async () => {
    const t = montar();
    await filaHeredada(t, {
      loginDeLaCuenta: 'login@x.com',
      titular: ['a@x.com', 'b@x.com'],
    });

    const r = await t.proceso.procesarPendientes(staff());

    expect(destinatarios(t).sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(r).toMatchObject({ enviadas: 1, correosEnviados: 2 });
  });

  it('A@X.com en la cuenta y a@x.com en la ficha son la misma dirección tras normalizar', async () => {
    const t = montar();
    await filaHeredada(t, {
      loginDeLaCuenta: 'A@X.com',
      titular: ['a@x.com'],
    });

    const r = await t.proceso.procesarPendientes(staff());

    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(r).toMatchObject({ enviadas: 1, correosEnviados: 0 });
  });

  it('solo consulta las cuentas de las filas reclamadas que traen correosEnviadosIds', async () => {
    const t = montar();
    t.agregarUnidad('B-1', [], {}, { titular: ['n@x.com'] });
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());
    expect(t.cuentasColeccion.escrituras).toEqual([]);
    const consultas = jest.spyOn(t.cuentasColeccion, 'find');

    const t2 = montar();
    const { fila } = await filaHeredada(t2, {
      loginDeLaCuenta: 'a@x.com',
      titular: ['a@x.com'],
    });
    const consultas2 = jest.spyOn(t2.cuentasColeccion, 'find');
    await t2.proceso.procesarPendientes(staff());

    expect(consultas).not.toHaveBeenCalled();
    expect(consultas2).toHaveBeenCalledTimes(1);
    expect(consultas2.mock.calls[0][0]).toEqual({
      _id: { $in: fila.correosEnviadosIds },
    });
  });

  it('si no se pueden leer las cuentas heredadas la llamada falla, suelta las filas y no envía nada', async () => {
    const t = montar();
    const { unidad } = await filaHeredada(t, {
      loginDeLaCuenta: 'a@x.com',
      titular: ['a@x.com', 'b@x.com'],
    });
    jest.spyOn(t.cuentasColeccion, 'find').mockImplementation(() => {
      throw new Error('mongo cortó');
    });

    await expect(t.proceso.procesarPendientes(staff())).rejects.toThrow(
      'mongo cortó',
    );

    expect(t.correo.enviar).not.toHaveBeenCalled();
    expect(t.fila(unidad)).toMatchObject({
      estado: 'pendiente_envio',
      tokenEnvio: null,
    });
  });
});
