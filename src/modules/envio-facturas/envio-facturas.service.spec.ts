import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { EnvioFacturasService } from './envio-facturas.service';
import { ColeccionMemoria } from './testing/coleccion-memoria';

const COP = new Types.ObjectId();
const OTRA_COP = new Types.ObjectId();
const LOTE = new Types.ObjectId();

const staff = (): IRequestUser => ({
  uid: 'uid-staff',
  email: 'ana@ejemplo.com',
  accountId: new Types.ObjectId().toString(),
  nombre: 'Ana Contadora',
  copropiedadId: COP.toString(),
});

function montar() {
  const envios = new ColeccionMemoria(['copropiedadId', 'facturaId']);
  const facturas = new ColeccionMemoria();
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const servicio = new EnvioFacturasService(
    envios as never,
    facturas as never,
    { resolveCoPropertyId: () => COP } as never,
    auditoria as never,
  );
  const factura = (
    codigo: string,
    over: Record<string, unknown> = {},
  ): Types.ObjectId => {
    const _id = new Types.ObjectId();
    facturas.insertar({
      _id,
      copropiedadId: COP,
      inmuebleId: new Types.ObjectId(),
      codigoInmueble: codigo,
      numeroCompleto: `FV-${codigo}`,
      estado: 'emitida',
      loteId: LOTE,
      ...over,
    });
    return _id;
  };
  return { envios, facturas, auditoria, servicio, factura };
}

describe('EnvioFacturasService.marcar', () => {
  it('audita ANTES de encolar: si la auditoría falla no queda ninguna fila marcada', async () => {
    const t = montar();
    t.factura('A-101');
    t.auditoria.registrar.mockRejectedValue(new Error('auditoría caída'));

    await expect(
      t.servicio.marcar({ loteId: LOTE.toString() }, staff()),
    ).rejects.toThrow('auditoría caída');
    expect(t.envios.docs).toHaveLength(0);
  });

  it('marca todas las facturas de un lote y no envía nada', async () => {
    const t = montar();
    t.factura('A-101');
    t.factura('A-102');

    const r = await t.servicio.marcar({ loteId: LOTE.toString() }, staff());

    expect(r).toEqual({
      marcadas: 2,
      yaPendientes: 0,
      yaEnviadas: 0,
      omitidasAnuladas: 0,
    });
    expect(t.envios.docs).toHaveLength(2);
    expect(t.envios.docs[0]).toMatchObject({
      estado: 'pendiente_envio',
      marcadoPorNombre: 'Ana Contadora',
      tokenEnvio: null,
      intentos: 0,
    });
    expect(t.envios.docs[0].marcadoEn).toBeInstanceOf(Date);
    // Marked, not released: residents still cannot open it.
    expect(t.envios.docs[0].liberadaEn).toBeUndefined();
    expect(t.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'marcar-envio',
        entidadTipo: 'envio-factura',
        entidadId: LOTE.toString(),
        actorNombre: 'Ana Contadora',
      }),
    );
  });

  it('marca una lista de facturas', async () => {
    const t = montar();
    const a = t.factura('A-101');
    t.factura('A-102');

    const r = await t.servicio.marcar({ facturaIds: [a.toString()] }, staff());

    expect(r.marcadas).toBe(1);
    expect(t.envios.docs).toHaveLength(1);
    expect(String(t.envios.docs[0].facturaId)).toBe(a.toString());
  });

  it('es idempotente: marcar dos veces no duplica ni vuelve a auditar', async () => {
    const t = montar();
    t.factura('A-101');
    t.factura('A-102');
    await t.servicio.marcar({ loteId: LOTE.toString() }, staff());
    t.auditoria.registrar.mockClear();

    const segunda = await t.servicio.marcar(
      { loteId: LOTE.toString() },
      staff(),
    );

    expect(segunda).toEqual({
      marcadas: 0,
      yaPendientes: 2,
      yaEnviadas: 0,
      omitidasAnuladas: 0,
    });
    expect(t.envios.docs).toHaveLength(2);
    expect(t.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('una factura ya enviada no se vuelve a encolar', async () => {
    const t = montar();
    const a = t.factura('A-101');
    await t.servicio.marcar({ facturaIds: [a.toString()] }, staff());
    t.envios.docs[0].estado = 'enviado';

    const r = await t.servicio.marcar({ facturaIds: [a.toString()] }, staff());

    expect(r).toMatchObject({ marcadas: 0, yaEnviadas: 1, yaPendientes: 0 });
    expect(t.envios.docs[0].estado).toBe('enviado');
  });

  it('una factura en error se vuelve a encolar conservando a quién ya se alcanzó', async () => {
    const t = montar();
    const a = t.factura('A-101');
    await t.servicio.marcar({ facturaIds: [a.toString()] }, staff());
    const alcanzado = new Types.ObjectId();
    Object.assign(t.envios.docs[0], {
      estado: 'error',
      ultimoError: 'reintentos_agotados',
      intentos: 5,
      notificadosIds: [alcanzado],
      correosEnviadosIds: [alcanzado],
    });

    const r = await t.servicio.marcar({ facturaIds: [a.toString()] }, staff());

    expect(r.marcadas).toBe(1);
    expect(t.envios.docs[0]).toMatchObject({
      estado: 'pendiente_envio',
      intentos: 0,
      ultimoError: null,
    });
    expect(t.envios.docs[0].correosEnviadosIds).toHaveLength(1);
  });

  it('las facturas anuladas se omiten y se cuentan', async () => {
    const t = montar();
    t.factura('A-101');
    t.factura('A-102', { estado: 'anulada' });

    const r = await t.servicio.marcar({ loteId: LOTE.toString() }, staff());

    expect(r).toMatchObject({ marcadas: 1, omitidasAnuladas: 1 });
    expect(t.envios.docs).toHaveLength(1);
  });

  describe('aislamiento entre copropiedades (IDOR)', () => {
    it('una lista con la factura de otra copropiedad se rechaza entera con 404 y no encola nada', async () => {
      const t = montar();
      const propia = t.factura('A-101');
      const ajena = t.factura('Z-901', { copropiedadId: OTRA_COP });

      await expect(
        t.servicio.marcar(
          { facturaIds: [propia.toString(), ajena.toString()] },
          staff(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(t.envios.docs).toHaveLength(0);
      expect(t.auditoria.registrar).not.toHaveBeenCalled();
    });

    it('un id inexistente responde igual que uno ajeno', async () => {
      const t = montar();
      t.factura('A-101');
      const ajena = t.factura('Z-901', { copropiedadId: OTRA_COP });

      const contraAjena = t.servicio
        .marcar({ facturaIds: [ajena.toString()] }, staff())
        .catch((e: Error) => e.message);
      const contraInexistente = t.servicio
        .marcar({ facturaIds: [new Types.ObjectId().toString()] }, staff())
        .catch((e: Error) => e.message);

      expect(await contraAjena).toBe(await contraInexistente);
    });

    it('un lote de otra copropiedad responde 404 y no encola nada', async () => {
      const t = montar();
      const loteAjeno = new Types.ObjectId();
      t.factura('Z-901', { copropiedadId: OTRA_COP, loteId: loteAjeno });

      await expect(
        t.servicio.marcar({ loteId: loteAjeno.toString() }, staff()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(t.envios.docs).toHaveLength(0);
    });

    it('el resumen solo cuenta la cola de la copropiedad activa', async () => {
      const t = montar();
      t.factura('A-101');
      await t.servicio.marcar({ loteId: LOTE.toString() }, staff());
      t.envios.insertar({
        _id: new Types.ObjectId(),
        copropiedadId: OTRA_COP,
        estado: 'pendiente_envio',
        tokenEnvio: null,
        proximoIntentoEn: null,
      });

      expect((await t.servicio.resumen()).pendientes).toBe(1);
    });
  });

  it('exige lote o lista, y solo uno de los dos', async () => {
    const t = montar();
    const a = t.factura('A-101');

    await expect(t.servicio.marcar({}, staff())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      t.servicio.marcar(
        { loteId: LOTE.toString(), facturaIds: [a.toString()] },
        staff(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.envios.docs).toHaveLength(0);
  });

  it('una sesión sin cuenta local no puede marcar (403)', async () => {
    const t = montar();
    t.factura('A-101');

    await expect(
      t.servicio.marcar(
        { loteId: LOTE.toString() },
        { uid: 'u', email: 'x@y.com' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('el resumen separa lo listo para procesar de lo retenido', async () => {
    const t = montar();
    t.factura('A-101');
    t.factura('A-102');
    t.factura('A-103');
    await t.servicio.marcar({ loteId: LOTE.toString() }, staff());
    t.envios.docs[0].tokenEnvio = 'viva';
    t.envios.docs[0].envioIniciadoEn = new Date();
    t.envios.docs[1].estado = 'error';

    expect(await t.servicio.resumen()).toEqual({
      pendientes: 1,
      enCurso: 1,
      enEspera: 0,
      enviadas: 0,
      conError: 1,
    });
  });

  it('el resumen separa lo que espera su reintento de lo que tiene un candado vivo', async () => {
    const t = montar();
    for (const unidad of ['A-101', 'A-102', 'A-103', 'A-104']) {
      t.factura(unidad);
    }
    await t.servicio.marcar({ loteId: LOTE.toString() }, staff());
    const futuro = new Date(Date.now() + 10 * 60_000);
    // Listo para procesar.
    // docs[1]: solo espera su reintento (sin candado).
    t.envios.docs[1].proximoIntentoEn = futuro;
    // docs[2]: candado vivo.
    t.envios.docs[2].tokenEnvio = 'viva';
    t.envios.docs[2].envioIniciadoEn = new Date();
    // docs[3]: candado vivo Y con espera de reintento: manda el candado.
    t.envios.docs[3].tokenEnvio = 'otra-viva';
    t.envios.docs[3].envioIniciadoEn = new Date();
    t.envios.docs[3].proximoIntentoEn = futuro;

    expect(await t.servicio.resumen()).toEqual({
      pendientes: 1,
      enCurso: 2,
      enEspera: 1,
      enviadas: 0,
      conError: 0,
    });
  });
});
