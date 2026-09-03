// src/modules/configuracion/interfaz-contable/interfaz-contable.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../../casl/policies.guard';
import { CheckAbility } from '../../casl/check-ability.decorator';
import { InterfazContableService } from './interfaz-contable.service';
import { GuardarMapeoDto } from './dto/guardar-mapeo.dto';
import type { MapeoContable } from '../../../contracts';

@Controller('interfaz-contable')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class InterfazContableController {
  constructor(private readonly interfaz: InterfazContableService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  findAll(): Promise<MapeoContable[]> {
    return this.interfaz.findAll();
  }

  @Post()
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  upsert(@Body() dto: GuardarMapeoDto): Promise<MapeoContable> {
    return this.interfaz.upsert(dto);
  }

  @Delete(':id')
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  remove(@Param('id') id: string): Promise<void> {
    return this.interfaz.remove(id);
  }
}
