import { Module } from '@nestjs/common';
import { TecnicosController } from './tecnicos.controller';
import { TecnicosService } from './tecnicos.service';

/**
 * Models come from the @Global DatabaseModule; guards and tenant context from
 * CommonModule. Independent of `PqrModule`: it only reads the PQR collection to
 * refuse deleting a technician with open work.
 */
@Module({
  controllers: [TecnicosController],
  providers: [TecnicosService],
})
export class TecnicosModule {}
