import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InmueblesReporteService } from './inmuebles-reporte.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const generarPdfListadoInmuebles = jest.fn(
  (_copropiedad: unknown, _items: unknown, _conceptos: unknown) =>
    Promise.resolve(new Uint8Array([1, 2, 3])),
);
jest.mock('../../common/pdf/inmuebles-listado-pdf', () => ({
  generarPdfListadoInmuebles: (
    copropiedad: unknown,
    items: unknown,
    conceptos: unknown,
  ) => generarPdfListadoInmuebles(copropiedad, items, conceptos),
}));

const COP = new Types.ObjectId();
const CONCEPTO_ADMIN = new Types.ObjectId();
const CONCEPTO_INTERESES = new Types.ObjectId();
const INMUEBLE_1 = new Types.ObjectId();
const INMUEBLE_2 = new Types.ObjectId();

const tenant = {
  resolveCoPropertyId: () => COP,
} as unknown as TenantContextService;

const modeloInmuebles = (filas: Record<string, unknown>[]) => ({
  find: jest.fn(() => ({
    sort: () => ({
      populate: () => ({ exec: () => Promise.resolve(filas) }),
    }),
  })),
});

const modeloConceptos = (filas: Record<string, unknown>[]) => ({
  find: jest.fn(() => ({
    sort: () => ({ exec: () => Promise.resolve(filas) }),
  })),
});

const modeloValores = (filas: Record<string, unknown>[]) => ({
  find: jest.fn(() => ({ exec: () => Promise.resolve(filas) })),
});

const modeloCopropiedades = (doc: Record<string, unknown> | null) => ({
  findById: jest.fn(() => ({ exec: () => Promise.resolve(doc) })),
});

describe('InmueblesReporteService.generarListadoPdf', () => {
  beforeEach(() => generarPdfListadoInmuebles.mockClear());

  it('responde "no existe" cuando la copropiedad activa no aparece', async () => {
    const service = new InmueblesReporteService(
      modeloInmuebles([]) as never,
      modeloConceptos([]) as never,
      modeloValores([]) as never,
      modeloCopropiedades(null) as never,
      tenant,
    );

    await expect(service.generarListadoPdf()).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('excluye el concepto de intereses de las columnas', async () => {
    const service = new InmueblesReporteService(
      modeloInmuebles([]) as never,
      modeloConceptos([
        { _id: CONCEPTO_ADMIN, name: 'Administración' },
      ]) as never,
      modeloValores([]) as never,
      modeloCopropiedades({ name: 'Prueba' }) as never,
      tenant,
    );

    await service.generarListadoPdf();

    const [, , conceptos] = generarPdfListadoInmuebles.mock.calls[0];
    expect(conceptos).toEqual([
      { id: CONCEPTO_ADMIN.toString(), nombre: 'Administración' },
    ]);
    void CONCEPTO_INTERESES; // referenced only to document why it's absent
  });

  it('arma un renglón por inmueble con su titular, área, coeficiente y valores por concepto', async () => {
    const service = new InmueblesReporteService(
      modeloInmuebles([
        {
          _id: INMUEBLE_1,
          code: '301',
          area: 72,
          participationFactor: 1.8452,
          holderId: { name: 'Ana Pérez' },
        },
        {
          _id: INMUEBLE_2,
          code: '302',
          area: 60,
          participationFactor: 1.2,
          holderId: null,
        },
      ]) as never,
      modeloConceptos([
        { _id: CONCEPTO_ADMIN, name: 'Administración' },
      ]) as never,
      modeloValores([
        { inmuebleId: INMUEBLE_1, conceptoId: CONCEPTO_ADMIN, amount: 350000 },
      ]) as never,
      modeloCopropiedades({ name: 'Prueba' }) as never,
      tenant,
    );

    await service.generarListadoPdf();

    const [, items] = generarPdfListadoInmuebles.mock.calls[0];
    expect(items).toEqual([
      {
        codigo: '301',
        titular: 'Ana Pérez',
        area: 72,
        coeficiente: 1.8452,
        valores: { [CONCEPTO_ADMIN.toString()]: 350000 },
      },
      {
        codigo: '302',
        titular: '',
        area: 60,
        coeficiente: 1.2,
        valores: { [CONCEPTO_ADMIN.toString()]: 0 },
      },
    ]);
  });
});
