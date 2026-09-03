import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InterfazContableService } from './interfaz-contable.service';

const COP = new Types.ObjectId();
const CUENTA_DB = new Types.ObjectId();
const CUENTA_CR = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();

const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

const mapeoDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  cargoTipo: 'concepto',
  conceptoId: CONCEPTO,
  cargoEspecial: null,
  cuentaDebitoId: CUENTA_DB,
  cuentaCreditoId: CUENTA_CR,
  ...over,
});

/** A findOne chain that resolves the fixture only when the filter's
 *  coPropertyId matches — proving cross-tenant references are checked, not
 *  just "an id that exists somewhere". */
const modeloCuentasCon = (idsPropias: Types.ObjectId[]) => ({
  findOne: jest.fn(({ _id, coPropertyId }: Record<string, unknown>) => ({
    exec: () =>
      Promise.resolve(
        coPropertyId === COP &&
          idsPropias.some((id) => id.toString() === String(_id))
          ? { _id, code: '11050501' }
          : null,
      ),
  })),
});

const modeloConceptosCon = (idsPropios: Types.ObjectId[]) => ({
  findOne: jest.fn(({ _id, coPropertyId }: Record<string, unknown>) => ({
    exec: () =>
      Promise.resolve(
        coPropertyId === COP &&
          idsPropios.some((id) => id.toString() === String(_id))
          ? { _id, name: 'Administración' }
          : null,
      ),
  })),
});

describe('InterfazContableService.upsert', () => {
  it('rechaza una cuenta débito de otra copropiedad', async () => {
    const mapeos = { findOne: jest.fn(), create: jest.fn() };
    const cuentas = modeloCuentasCon([]); // ninguna cuenta es de esta copropiedad
    const conceptos = modeloConceptosCon([CONCEPTO]);
    const service = new InterfazContableService(
      mapeos as never,
      cuentas as never,
      conceptos as never,
      tenant(),
    );

    await expect(
      service.upsert({
        cargoTipo: 'concepto',
        conceptoId: CONCEPTO.toString(),
        cuentaDebitoId: CUENTA_DB.toString(),
        cuentaCreditoId: CUENTA_CR.toString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mapeos.create).not.toHaveBeenCalled();
  });

  it('rechaza un concepto de otra copropiedad', async () => {
    const mapeos = { findOne: jest.fn(), create: jest.fn() };
    const cuentas = modeloCuentasCon([CUENTA_DB, CUENTA_CR]);
    const conceptos = modeloConceptosCon([]); // el concepto no es de esta copropiedad
    const service = new InterfazContableService(
      mapeos as never,
      cuentas as never,
      conceptos as never,
      tenant(),
    );

    await expect(
      service.upsert({
        cargoTipo: 'concepto',
        conceptoId: CONCEPTO.toString(),
        cuentaDebitoId: CUENTA_DB.toString(),
        cuentaCreditoId: CUENTA_CR.toString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige conceptoId cuando cargoTipo es "concepto"', async () => {
    const mapeos = { findOne: jest.fn(), create: jest.fn() };
    const cuentas = modeloCuentasCon([CUENTA_DB, CUENTA_CR]);
    const service = new InterfazContableService(
      mapeos as never,
      cuentas as never,
      modeloConceptosCon([]) as never,
      tenant(),
    );

    await expect(
      service.upsert({
        cargoTipo: 'concepto',
        cuentaDebitoId: CUENTA_DB.toString(),
        cuentaCreditoId: CUENTA_CR.toString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('crea un mapeo nuevo cuando no existe uno para ese cargo', async () => {
    const mapeos = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      create: jest.fn((doc: Record<string, unknown>) =>
        Promise.resolve(mapeoDoc(doc)),
      ),
    };
    const cuentas = modeloCuentasCon([CUENTA_DB, CUENTA_CR]);
    const conceptos = modeloConceptosCon([CONCEPTO]);
    const service = new InterfazContableService(
      mapeos as never,
      cuentas as never,
      conceptos as never,
      tenant(),
    );

    await service.upsert({
      cargoTipo: 'concepto',
      conceptoId: CONCEPTO.toString(),
      cuentaDebitoId: CUENTA_DB.toString(),
      cuentaCreditoId: CUENTA_CR.toString(),
    });

    expect(mapeos.create).toHaveBeenCalledWith(
      expect.objectContaining({ coPropertyId: COP }),
    );
  });

  it('actualiza el mapeo existente en vez de duplicarlo — un mapeo por cargo', async () => {
    const existente = mapeoDoc();
    const mapeos = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(existente) })),
      create: jest.fn((_doc: Record<string, unknown>) => Promise.resolve(null)),
      findByIdAndUpdate: jest.fn(
        (
          _id: Types.ObjectId,
          _update: Record<string, unknown>,
          _opts: Record<string, unknown>,
        ) => ({
          exec: () => Promise.resolve(mapeoDoc({ cuentaDebitoId: CUENTA_CR })),
        }),
      ),
    };
    const cuentas = modeloCuentasCon([CUENTA_DB, CUENTA_CR]);
    const conceptos = modeloConceptosCon([CONCEPTO]);
    const service = new InterfazContableService(
      mapeos as never,
      cuentas as never,
      conceptos as never,
      tenant(),
    );

    await service.upsert({
      cargoTipo: 'concepto',
      conceptoId: CONCEPTO.toString(),
      cuentaDebitoId: CUENTA_CR.toString(),
      cuentaCreditoId: CUENTA_DB.toString(),
    });

    expect(mapeos.create).not.toHaveBeenCalled();
    expect(mapeos.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    const llamada = mapeos.findByIdAndUpdate.mock.calls[0];
    const idEsperado: Types.ObjectId = existente._id;
    expect(llamada[0]).toBe(idEsperado);
    expect(llamada[2]).toEqual({ new: true });
  });

  it('exige cargoEspecial cuando cargoTipo es "especial"', async () => {
    const mapeos = { findOne: jest.fn(), create: jest.fn() };
    const cuentas = modeloCuentasCon([CUENTA_DB, CUENTA_CR]);
    const service = new InterfazContableService(
      mapeos as never,
      cuentas as never,
      {} as never,
      tenant(),
    );

    await expect(
      service.upsert({
        cargoTipo: 'especial',
        cuentaDebitoId: CUENTA_DB.toString(),
        cuentaCreditoId: CUENTA_CR.toString(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InterfazContableService.remove', () => {
  it('responde "no existe" cuando el id no corresponde a ningún mapeo de esta copropiedad', async () => {
    const mapeos = {
      deleteOne: jest.fn(() => ({
        exec: () => Promise.resolve({ deletedCount: 0 }),
      })),
    };
    const service = new InterfazContableService(
      mapeos as never,
      {} as never,
      {} as never,
      tenant(),
    );

    await expect(service.remove('map-ajeno')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('elimina el mapeo scopeado a la copropiedad activa', async () => {
    const mapeos = {
      deleteOne: jest.fn(() => ({
        exec: () => Promise.resolve({ deletedCount: 1 }),
      })),
    };
    const service = new InterfazContableService(
      mapeos as never,
      {} as never,
      {} as never,
      tenant(),
    );

    await service.remove('map-1');

    expect(mapeos.deleteOne).toHaveBeenCalledWith({
      _id: 'map-1',
      coPropertyId: COP,
    });
  });
});
