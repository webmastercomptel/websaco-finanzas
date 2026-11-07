import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { Types } from 'mongoose';
import { PortalService } from './portal.service';
import type { RolPortal } from './portal-acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { ColeccionMemoria } from '../envio-facturas/testing/coleccion-memoria';

const MI_UNIDAD = new Types.ObjectId().toString();
const OTRA_UNIDAD = new Types.ObjectId().toString();
const FACTURA = new Types.ObjectId().toString();

const usuario: IRequestUser = {
  uid: 'u',
  email: 'ana@ejemplo.com',
  accountId: new Types.ObjectId().toString(),
  copropiedadId: new Types.ObjectId().toString(),
  esResidente: true,
  permissions: [],
};

/** A full invoice as `FacturasService.findAll` returns it (owner contract). */
const facturaCompleta = {
  id: FACTURA,
  loteId: 'lote-1',
  inmuebleId: MI_UNIDAD,
  inmuebleCodigo: 'A-101',
  terceroId: 'tercero-1',
  titular: { nombre: 'Ana Propietaria', identificacion: '123' },
  prefijo: 'FV',
  numero: 7,
  numeroCompleto: 'FV-7',
  fechaEmision: '2026-05-01',
  fechaVencimiento: '2026-05-15',
  periodoDesde: '2026-05-01',
  periodoHasta: '2026-05-31',
  lineas: [{ concepto: 'Administración', monto: 1000 }],
  saldosInformativos: [{ concepto: 'Multa', saldo: 50 }],
  subtotal: 1000,
  totalImpuestos: 0,
  total: 1000,
  saldoPendiente: 400,
  montoDescuento: 10,
  fechaLimiteDescuento: '2026-05-10',
  estado: 'emitida',
  motivoAnulacion: null,
  detalleAnulacion: null,
  fechaAnulacion: null,
};

/** Acceso that knows one unit, held with `rol`. */
const accesoCon = (rol: RolPortal) => ({
  unidadesDe: jest.fn(),
  rolEn: jest.fn((_a: string, _c: string, inmuebleId: string) =>
    Promise.resolve(inmuebleId === MI_UNIDAD ? rol : null),
  ),
});

const paginaPdf = async (): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  return Buffer.from(await doc.save());
};

/** The send queue as the portal sees it: which invoices were released, and when. */
const colaCon = (
  filas: {
    facturaId: string;
    inmuebleId?: string;
    liberada?: boolean;
    copropiedadId?: string;
  }[],
) => {
  const cola = new ColeccionMemoria();
  for (const f of filas) {
    cola.insertar({
      _id: new Types.ObjectId(),
      copropiedadId: new Types.ObjectId(
        f.copropiedadId ?? usuario.copropiedadId,
      ),
      facturaId: new Types.ObjectId(f.facturaId),
      inmuebleId: new Types.ObjectId(f.inmuebleId ?? MI_UNIDAD),
      ...(f.liberada === false ? {} : { liberadaEn: new Date() }),
    });
  }
  return cola;
};

const construir = async (
  rol: RolPortal,
  cola: ColeccionMemoria = colaCon([{ facturaId: FACTURA }]),
) => {
  const acceso = accesoCon(rol);
  const facturas = {
    findAll: jest.fn(() =>
      Promise.resolve({
        items: [facturaCompleta],
        total: 1,
        pagina: 1,
        porPagina: 50,
        totales: { total: 1000, saldoPendiente: 400 },
      }),
    ),
    findOneRaw: jest.fn((id: string) =>
      Promise.resolve({
        _id: id,
        inmuebleId: new Types.ObjectId(
          id === FACTURA ? MI_UNIDAD : OTRA_UNIDAD,
        ),
        printSnapshot: {},
        paginaEnLote: 1,
        loteId: 'lote-1',
        estado: 'emitida',
      }),
    ),
  };
  const estadoCuenta = { findAll: jest.fn(() => Promise.resolve({})) };
  const presentacion = {
    buscar: jest.fn(() => Promise.resolve({ objectPath: 'x/FV/1.pdf' })),
  };
  const bytes = await paginaPdf();
  const storage = { descargarBytes: jest.fn(() => Promise.resolve(bytes)) };
  const service = new PortalService(
    acceso as never,
    facturas as never,
    estadoCuenta as never,
    presentacion as never,
    storage as never,
    cola as never,
  );
  return { service, facturas, estadoCuenta, acceso };
};

describe('PortalService.facturasDe', () => {
  it('un arrendatario ve las facturas de su unidad', async () => {
    const { service, facturas } = await construir('arrendatario');

    await service.facturasDe(usuario, { inmuebleId: MI_UNIDAD, pagina: 2 });

    expect(facturas.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ inmuebleId: MI_UNIDAD, pagina: 2 }),
      expect.anything(),
    );
  });

  it('al arrendatario solo se le devuelve la factura: sin saldo, titular, líneas ni totales', async () => {
    const { service } = await construir('arrendatario');

    const pagina = await service.facturasDe(usuario, { inmuebleId: MI_UNIDAD });

    expect(pagina).toEqual({
      items: [
        {
          id: FACTURA,
          inmuebleId: MI_UNIDAD,
          inmuebleCodigo: 'A-101',
          numeroCompleto: 'FV-7',
          fechaEmision: '2026-05-01',
          fechaVencimiento: '2026-05-15',
          periodoDesde: '2026-05-01',
          periodoHasta: '2026-05-31',
          total: 1000,
          estado: 'emitida',
        },
      ],
      total: 1,
      pagina: 1,
      porPagina: 50,
    });
    expect(pagina).not.toHaveProperty('totales');
    expect(JSON.stringify(pagina)).not.toMatch(
      /saldo|titular|terceroId|loteId|Descuento|Anulacion|lineas/i,
    );
  });

  it('al propietario se le devuelve el contrato completo de la factura', async () => {
    const { service } = await construir('propietario');

    const pagina = await service.facturasDe(usuario, { inmuebleId: MI_UNIDAD });

    expect(pagina.items[0]).toEqual(facturaCompleta);
  });

  it('solo lista facturas liberadas a los residentes: pide únicamente esos ids', async () => {
    const liberada = new Types.ObjectId().toString();
    const marcadaSinEnviar = new Types.ObjectId().toString();
    const deOtraUnidad = new Types.ObjectId().toString();
    const deOtraCopropiedad = new Types.ObjectId().toString();
    const cola = colaCon([
      { facturaId: liberada },
      { facturaId: marcadaSinEnviar, liberada: false },
      { facturaId: deOtraUnidad, inmuebleId: OTRA_UNIDAD },
      {
        facturaId: deOtraCopropiedad,
        copropiedadId: new Types.ObjectId().toString(),
      },
    ]);
    const { service, facturas } = await construir('propietario', cola);

    await service.facturasDe(usuario, { inmuebleId: MI_UNIDAD });

    const [, opciones] = (
      facturas.findAll.mock.calls as unknown as Array<
        [unknown, { soloIds: Types.ObjectId[] }]
      >
    )[0];
    expect(opciones.soloIds.map(String)).toEqual([liberada]);
  });

  it('una unidad sin facturas liberadas devuelve una página vacía sin consultar facturas', async () => {
    const { service, facturas } = await construir(
      'arrendatario',
      colaCon([{ facturaId: FACTURA, liberada: false }]),
    );

    const pagina = await service.facturasDe(usuario, {
      inmuebleId: MI_UNIDAD,
    });

    expect(pagina).toEqual({ items: [], total: 0, pagina: 1, porPagina: 50 });
    expect(facturas.findAll).not.toHaveBeenCalled();
  });

  it('una unidad ajena responde 404 y no consulta facturas', async () => {
    const { service, facturas } = await construir('propietario');

    await expect(
      service.facturasDe(usuario, { inmuebleId: OTRA_UNIDAD }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(facturas.findAll).not.toHaveBeenCalled();
  });

  it('nunca pide totales ni otro filtro que el cliente no controle', async () => {
    const { service, facturas } = await construir('propietario');

    await service.facturasDe(usuario, { inmuebleId: MI_UNIDAD });

    const consulta = (
      facturas.findAll.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0][0];
    expect(consulta).not.toHaveProperty('incluirTotales');
    expect(Object.keys(consulta).sort()).toEqual([
      'inmuebleId',
      'pagina',
      'porPagina',
    ]);
  });
});

describe('PortalService.documentoPdfDeFactura', () => {
  it('entrega el PDF de una factura de la unidad del residente', async () => {
    const { service } = await construir('arrendatario');

    const bytes = await service.documentoPdfDeFactura(usuario, FACTURA);

    expect(bytes.length).toBeGreaterThan(0);
  });

  it('una factura marcada para enviar pero aún no liberada responde 404', async () => {
    const { service } = await construir(
      'propietario',
      colaCon([{ facturaId: FACTURA, liberada: false }]),
    );

    await expect(
      service.documentoPdfDeFactura(usuario, FACTURA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('una factura que nunca se marcó responde 404 aunque sea de la unidad del residente', async () => {
    const { service } = await construir('propietario', colaCon([]));

    await expect(
      service.documentoPdfDeFactura(usuario, FACTURA),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('una factura de una unidad ajena responde 404', async () => {
    const { service } = await construir('propietario');
    const ajena = new Types.ObjectId().toString();

    await expect(
      service.documentoPdfDeFactura(usuario, ajena),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un id que no es ObjectId responde 404 sin consultar nada', async () => {
    const { service, facturas } = await construir('propietario');

    await expect(
      service.documentoPdfDeFactura(usuario, 'no-es-un-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(facturas.findOneRaw).not.toHaveBeenCalled();
  });
});

describe('PortalService.estadoCuentaDe', () => {
  const periodo = {
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  };

  it('el propietario ve el estado de cuenta de su unidad', async () => {
    const { service, estadoCuenta } = await construir('propietario');

    await service.estadoCuentaDe(usuario, {
      inmuebleId: MI_UNIDAD,
      ...periodo,
    });

    expect(estadoCuenta.findAll).toHaveBeenCalledWith(
      { inmuebleId: MI_UNIDAD, ...periodo },
      expect.anything(),
    );
  });

  it('una factura no liberada no aparece en el estado de cuenta del propietario: solo se le pasan las liberadas de su unidad', async () => {
    const liberada = new Types.ObjectId().toString();
    const sinLiberar = new Types.ObjectId().toString();
    const deOtraUnidad = new Types.ObjectId().toString();
    const { service, estadoCuenta } = await construir(
      'propietario',
      colaCon([
        { facturaId: liberada },
        { facturaId: sinLiberar, liberada: false },
        { facturaId: deOtraUnidad, inmuebleId: OTRA_UNIDAD },
      ]),
    );

    await service.estadoCuentaDe(usuario, {
      inmuebleId: MI_UNIDAD,
      ...periodo,
    });

    const [, opciones] = (
      estadoCuenta.findAll.mock.calls as unknown as Array<
        [unknown, { facturasVisibles: Types.ObjectId[] }]
      >
    )[0];
    expect(opciones.facturasVisibles.map(String)).toEqual([liberada]);
  });

  it('sin facturas liberadas el estado de cuenta se pide con la lista vacía (no con todas)', async () => {
    const { service, estadoCuenta } = await construir(
      'propietario',
      colaCon([{ facturaId: FACTURA, liberada: false }]),
    );

    await service.estadoCuentaDe(usuario, {
      inmuebleId: MI_UNIDAD,
      ...periodo,
    });

    const [, opciones] = (
      estadoCuenta.findAll.mock.calls as unknown as Array<
        [unknown, { facturasVisibles: Types.ObjectId[] }]
      >
    )[0];
    expect(opciones.facturasVisibles).toEqual([]);
  });

  it('el arrendatario recibe 403 y no se consulta el estado de cuenta', async () => {
    const { service, estadoCuenta } = await construir('arrendatario');

    await expect(
      service.estadoCuentaDe(usuario, { inmuebleId: MI_UNIDAD, ...periodo }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(estadoCuenta.findAll).not.toHaveBeenCalled();
  });

  it('una unidad ajena responde 404, no 403, para no confirmar que existe', async () => {
    const { service } = await construir('propietario');

    await expect(
      service.estadoCuentaDe(usuario, { inmuebleId: OTRA_UNIDAD, ...periodo }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
