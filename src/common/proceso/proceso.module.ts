import { Module } from '@nestjs/common';
import { RolProcesoService } from './rol-proceso.service';

/** Applies `APP_ROLE` (see `RolProcesoService`). Import after `BullModule`. */
@Module({ providers: [RolProcesoService] })
export class ProcesoModule {}
