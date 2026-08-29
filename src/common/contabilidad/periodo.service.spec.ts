import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PeriodoService, periodoDe } from './periodo.service';

const COP = new Types.ObjectId().toString();

type Filtro = Record<string, unknown>;

const periodosCon = (fila: Record<string, unknown> | null) => ({
  // The filter parameter is declared so jest infers it into the call tuple —
  // one test asserts which period was looked up.
  findOne: jest.fn((_filtro: Filtro) => ({
    lean: () => ({ exec: () => Promise.resolve(fila) }),
  })),
});

const servicio = (fila: Record<string, unknown> | null) =>
  new PeriodoService(periodosCon(fila) as never);

/** 15 March 2026, local time. */
const enMarzo = new Date(2026, 2, 15);

describe('periodoDe', () => {
  it('lee el mes en hora local, no en UTC', () => {
    // Una factura del día 1 a las 00:30 en Bogotá es enero allá y diciembre en
    // UTC. El borde del mes es justo donde un off-by-one mete un documento en
    // un periodo que alguien ya cerró.
    const primeroDeEnero = new Date(2026, 0, 1, 0, 30);

    expect(periodoDe(primeroDeEnero)).toEqual({ year: 2026, month: 1 });
  });

  it('numera los meses de 1 a 12, no desde cero', () => {
    expect(periodoDe(new Date(2026, 11, 31))).toEqual({
      year: 2026,
      month: 12,
    });
  });
});

describe('PeriodoService', () => {
  it('un mes sin registro está abierto', async () => {
    // Los periodos se crean al cerrarlos. Si la ausencia significara "cerrado",
    // habría que fabricar doce filas por año antes de poder facturar.
    const service = servicio(null);

    await expect(service.estaAbierto(COP, enMarzo)).resolves.toBe(true);
    await expect(service.exigirAbierto(COP, enMarzo)).resolves.toBeUndefined();
  });

  it('un mes marcado abierto acepta documentos', async () => {
    const service = servicio({ year: 2026, month: 3, status: 'abierto' });

    await expect(service.estaAbierto(COP, enMarzo)).resolves.toBe(true);
  });

  it('un mes cerrado los rechaza', async () => {
    const service = servicio({ year: 2026, month: 3, status: 'cerrado' });

    await expect(service.estaAbierto(COP, enMarzo)).resolves.toBe(false);
    await expect(service.exigirAbierto(COP, enMarzo)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('el error nombra el periodo cerrado', async () => {
    const service = servicio({ year: 2026, month: 3, status: 'cerrado' });

    await expect(service.exigirAbierto(COP, enMarzo)).rejects.toThrow(
      '03/2026',
    );
  });

  it('el error dice qué hacer en su lugar', async () => {
    // Encontrar un error hoy en un documento de un mes cerrado no se arregla
    // reabriendo el mes: se emite una nota con fecha de hoy que referencia el
    // documento viejo. El mensaje tiene que decir eso, o alguien va a buscar
    // cómo reabrirlo.
    const service = servicio({ year: 2026, month: 3, status: 'cerrado' });

    await expect(service.exigirAbierto(COP, enMarzo)).rejects.toThrow(
      /referenciando el documento original/,
    );
  });

  it('consulta el periodo de la fecha del documento, no el de hoy', async () => {
    const periodos = periodosCon(null);
    const service = new PeriodoService(periodos as never);

    await service.estaAbierto(COP, new Date(2026, 0, 31));

    const [filtro] = periodos.findOne.mock.calls[0];
    expect(filtro).toMatchObject({ year: 2026, month: 1 });
  });
});
