// src/modules/inmuebles/inmuebles.module.ts
import { Module } from '@nestjs/common';
import { InmueblesController } from './inmuebles.controller';
import { InmueblesService } from './inmuebles.service';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule, so there is nothing to import here.
 */
@Module({
  controllers: [InmueblesController],
  providers: [InmueblesService],
})
export class InmueblesModule {}
