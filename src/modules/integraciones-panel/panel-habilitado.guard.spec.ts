import { ServiceUnavailableException } from '@nestjs/common';
import { PanelHabilitadoGuard } from './panel-habilitado.guard';

const mockConfig = (habilitado: unknown) => ({
  get: jest.fn((clave: string) =>
    clave === 'app.integracionPanelHabilitada' ? habilitado : undefined,
  ),
});

describe('PanelHabilitadoGuard', () => {
  it('apagado: 503 con el código PANEL_APAGADO', () => {
    const guard = new PanelHabilitadoGuard(mockConfig(false) as never);

    try {
      guard.canActivate();
      throw new Error('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect((e as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'PANEL_APAGADO',
      });
    }
  });

  it('sin definir cuenta como apagado (falla cerrado)', () => {
    const guard = new PanelHabilitadoGuard(mockConfig(undefined) as never);

    expect(() => guard.canActivate()).toThrow(ServiceUnavailableException);
  });

  it('encendido: deja pasar', () => {
    const guard = new PanelHabilitadoGuard(mockConfig(true) as never);

    expect(guard.canActivate()).toBe(true);
  });
});
