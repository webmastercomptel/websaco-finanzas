import { ForbiddenException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { TenantContextService } from './tenant-context.service';
import { ACTIVE_COPROPERTY_KEY } from './tenant-context.constants';

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
    const service = new TenantContextService(clsWith('COP-001'));

    expect(service.resolveCoPropertyId()).toBe('COP-001');
  });

  it('falla cerrado cuando no hay copropiedad activa', () => {
    const service = new TenantContextService(clsWith());

    // Sin tenant no hay consulta segura posible: nunca debe devolver un valor
    // por defecto ni caer a "la primera copropiedad".
    expect(() => service.resolveCoPropertyId()).toThrow(ForbiddenException);
  });

  it('acepta un id explícito solo si coincide con el activo', () => {
    const service = new TenantContextService(clsWith('COP-001'));

    expect(service.resolveCoPropertyId('COP-001')).toBe('COP-001');
  });

  it('rechaza un id explícito distinto al activo (intento cross-tenant)', () => {
    const service = new TenantContextService(clsWith('COP-001'));

    expect(() => service.resolveCoPropertyId('COP-999')).toThrow(
      ForbiddenException,
    );
  });

  it('rechaza un id explícito cuando no hay ningún tenant activo', () => {
    const service = new TenantContextService(clsWith());

    // El id del cliente no puede ESTABLECER el tenant, solo confirmarlo.
    expect(() => service.resolveCoPropertyId('COP-001')).toThrow(
      ForbiddenException,
    );
  });

  it('devuelve el id como string plano, no como ObjectId', () => {
    // Finanzas no es dueño del catálogo: coPropertyId es una clave lógica sin
    // colección local detrás, así que jamás se convierte a ObjectId.
    const service = new TenantContextService(clsWith('COP-001'));

    expect(typeof service.resolveCoPropertyId()).toBe('string');
  });

  describe('activeCoPropertyIdOrNull', () => {
    it('devuelve undefined en lugar de fallar cuando no hay tenant', () => {
      const service = new TenantContextService(clsWith());

      expect(service.activeCoPropertyIdOrNull()).toBeUndefined();
    });

    it('devuelve el tenant activo cuando existe', () => {
      const service = new TenantContextService(clsWith('COP-002'));

      expect(service.activeCoPropertyIdOrNull()).toBe('COP-002');
    });
  });
});
