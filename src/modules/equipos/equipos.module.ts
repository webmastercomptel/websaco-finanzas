import { Module } from '@nestjs/common';
import { EquiposController } from './equipos.controller';
import { EquiposService } from './equipos.service';

/**
 * Models come from the @Global DatabaseModule; guards and tenant context from
 * CommonModule. Must NOT import `MantenimientosModule` (that one imports this
 * to validate `equipoId`): it only reads the maintenance collection to refuse
 * deleting equipment with history.
 */
@Module({
  controllers: [EquiposController],
  providers: [EquiposService],
  exports: [EquiposService],
})
export class EquiposModule {}
