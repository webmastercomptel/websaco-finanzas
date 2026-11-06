import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { Types } from 'mongoose';
import { PortalService } from './portal.service';
import type { RolPortal } from './portal-acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

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

const construir = async (rol: RolPortal) => {
  const acceso = accesoCon(rol);
  const facturas = {
    findAll: jest.fn(() => Promise.resolve({ datos: [] })),
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
  );
  return { service, facturas, estadoCuenta, acceso };
};

describe('PortalService.facturasDe', () => {
  it('un arrendatario ve las facturas de su unidad', async () => {
    const { service, facturas } = await construir('arrendatario');

    await service.facturasDe(usuario, { inmuebleId: MI_UNIDAD, pagina: 2 });

    expect(facturas.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ inmuebleId: MI_UNIDAD, pagina: 2 }),
    );
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

    expect(estadoCuenta.findAll).toHaveBeenCalledWith({
      inmuebleId: MI_UNIDAD,
      ...periodo,
    });
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
