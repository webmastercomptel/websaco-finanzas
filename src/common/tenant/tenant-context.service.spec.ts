import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { ClsService } from 'nestjs-cls';
import { TenantContextService } from './tenant-context.service';
import { ACTIVE_COPROPERTY_KEY } from './tenant-context.constants';

const COP = new Types.ObjectId().toString();
const OTRA = new Types.ObjectId().toString();

/** ClsService stub backed by a plain map. */
const clsWith = (value?: string): ClsService => {
  const store: Record<string, unknown> = {};
  if (value !== undefined) store[ACTIVE_COPROPERTY_KEY] = value;
  return {
    get: (key: string) => store[key],
  } as unknown as ClsService;
};

describe('TenantContextService', () => {
  it('devuelve la copropiedad activa del contexto', () => {
    const service = new TenantContextService(clsWith(COP));

    expect(service.resolveCoPropertyId().toString()).toBe(COP);
  });

  it('devuelve un ObjectId, no un string', () => {
    // No es cuestión de gusto: el driver NO convierte un string a ObjectId al
    // comparar contra este campo, así que un filtro armado con la forma string
    // no matchea NADA. Y devuelve lista vacía en vez de error — la peor falla
    // posible, porque la pantalla dice "este edificio no tiene unidades" para
    // un edificio que tiene sesenta.
    const service = new TenantContextService(clsWith(COP));

    expect(service.resolveCoPropertyId()).toBeInstanceOf(Types.ObjectId);
  });

  it('falla cerrado cuando no hay copropiedad activa', () => {
    const service = new TenantContextService(clsWith());

    // Sin tenant no hay consulta segura posible: nunca debe devolver un valor
    // por defecto ni caer a "la primera copropiedad".
    expect(() => service.resolveCoPropertyId()).toThrow(ForbiddenException);
  });

  it('acepta un id explícito solo si coincide con el activo', () => {
    const service = new TenantContextService(clsWith(COP));

    expect(service.resolveCoPropertyId(COP).toString()).toBe(COP);
  });

  it('rechaza un id explícito distinto al activo (intento cross-tenant)', () => {
    const service = new TenantContextService(clsWith(COP));

    expect(() => service.resolveCoPropertyId(OTRA)).toThrow(ForbiddenException);
  });

  it('rechaza un id explícito cuando no hay ningún tenant activo', () => {
    const service = new TenantContextService(clsWith());

    // El id del cliente no puede ESTABLECER el tenant, solo confirmarlo.
    expect(() => service.resolveCoPropertyId(COP)).toThrow(ForbiddenException);
  });

  it('rechaza un valor de contexto que no es un ObjectId válido', () => {
    // Inalcanzable a través del guard, que valida antes de escribir. Está para
    // que un futuro escritor de este contexto no meta un valor que reventaría
    // lejos de acá, como un CastError dentro de la consulta de otro.
    const service = new TenantContextService(clsWith('no-es-un-object-id'));

    expect(() => service.resolveCoPropertyId()).toThrow(ForbiddenException);
  });

  describe('activeCoPropertyIdOrNull', () => {
    it('devuelve undefined en lugar de fallar cuando no hay tenant', () => {
      const service = new TenantContextService(clsWith());

      expect(service.activeCoPropertyIdOrNull()).toBeUndefined();
    });

    it('devuelve el tenant activo como el string que se recibió', () => {
      const service = new TenantContextService(clsWith(COP));

      expect(service.activeCoPropertyIdOrNull()).toBe(COP);
    });
  });
});
