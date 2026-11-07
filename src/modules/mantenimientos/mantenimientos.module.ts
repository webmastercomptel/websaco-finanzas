// src/modules/mantenimientos/mantenimientos.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { MantenimientosController } from './mantenimientos.controller';
import { MantenimientosService } from './mantenimientos.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context, the
 * directory and mail from CommonModule. Imports the inbox module to notify a
 * technician who also has an account.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [MantenimientosController],
  providers: [MantenimientosService],
})
export class MantenimientosModule {}
