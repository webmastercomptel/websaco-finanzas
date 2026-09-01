import { Module } from '@nestjs/common';
import { NotasContablesController } from './notas-contables.controller';
import { NotasContablesService } from './notas-contables.service';

@Module({
  controllers: [NotasContablesController],
  providers: [NotasContablesService],
})
export class NotasContablesModule {}
