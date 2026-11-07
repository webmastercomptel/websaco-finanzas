import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { ResidenteDeInmueble } from '../../common/directorio/directorio.service';
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
function montar(opciones: { correoConfigurado?: boolean } = {}) {
  const envios = new ColeccionMemoria(['copropiedadId', 'facturaId']);
  const facturas = new ColeccionMemoria();
  const unidades: Unidad[] = [];
  const residentesPorUnidad = new Map<string, ResidenteDeInmueble[]>();

  const agregarUnidad = (
    codigo: string,
    residentes: ResidenteDeInmueble[],
    over: Record<string, unknown> = {},
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
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };
  const enlaces = {
    construir: jest
      .fn()
      .mockResolvedValue('https://app.ejemplo.com/auth/enlace?token=t'),
  };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const directorio = {
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

  it('el correo lleva un enlace al portal y no adjunta la factura ni muestra montos', async () => {
    const t = montar();
    t.agregarUnidad('A-101', [residente('propietario', 'Pedro <b>Pérez</b>')]);
    await t.marcarTodas();

    await t.proceso.procesarPendientes(staff());

    const [mensaje] = t.correo.enviar.mock.calls[0];
    expect(mensaje).not.toHaveProperty('adjuntos');
    expect(mensaje.asunto).toBe('Tu factura FV-A-101 ya está disponible');
    expect(mensaje.html).toContain('FV-A-101');
    expect(mensaje.html).toContain(
      'https://app.ejemplo.com/auth/enlace?token=t',
    );
    expect(mensaje.html).toContain('octubre de 2026');
    expect(mensaje.html).not.toContain('<b>Pérez</b>'); // names are escaped
    expect(mensaje.html).not.toMatch(/\$|total|saldo/i);
    const [, , destino] = t.enlaces.construir.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(destino).toMatch(
      /^\/portal\/facturas\?inmuebleId=[0-9a-f]{24}&abrir=[0-9a-f]{24}$/,
    );
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
      expect(primera.enCurso).toBe(1);

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
      fila.correosEnviadosIds = [new Types.ObjectId(propietario.accountId)];

      const r = await t.proceso.procesarPendientes(staff());

      expect(r).toMatchObject({
        reclamadas: 1,
        enviadas: 1,
        correosEnviados: 1,
      });
      expect(t.correo.enviar).toHaveBeenCalledTimes(1);
      expect(t.correo.enviar.mock.calls[0][0].para).toBe(arrendatario.email);
      expect(fila.correosEnviadosIds).toHaveLength(2);
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

      expect(r).toMatchObject({ reclamadas: 0, hayMas: false, enCurso: 1 });
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

    expect(segundo).toMatchObject({ reclamadas: 0, hayMas: false, enCurso: 1 });
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
});
