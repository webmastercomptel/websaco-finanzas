// src/modules/integraciones-panel/panel-habilitado.guard.ts
import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Master switch of the panel module (`INTEGRACION_PANEL_HABILITADA`, off by
 * default). MUST run AFTER `FirmaPanelGuard`: an unsigned caller gets the same
 * opaque 401 whether the module is on or off, and only a caller holding the
 * secret learns it is off. Off means no read and no write at all.
 *
 * The body carries `code` (not `codigo`): the panel reads that field.
 */
@Injectable()
export class PanelHabilitadoGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get<boolean>('app.integracionPanelHabilitada') !== true) {
      throw new ServiceUnavailableException({
        code: 'PANEL_APAGADO',
        message:
          'La integración con el panel de integraciones está apagada en este sistema.',
      });
    }
    return true;
  }
}
