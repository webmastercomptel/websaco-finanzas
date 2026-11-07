// src/modules/tareas/tareas.module.ts
import { Module } from '@nestjs/common';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { TareasController } from './tareas.controller';
import { TareasService } from './tareas.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context, the
 * directory, mail and access links from CommonModule. Imports the inbox module
 * to notify assignees.
 */
@Module({
  imports: [NotificacionesModule],
  controllers: [TareasController],
  providers: [TareasService],
})
export class TareasModule {}
