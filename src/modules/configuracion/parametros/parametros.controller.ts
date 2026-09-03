// src/modules/configuracion/parametros/parametros.controller.ts
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../../casl/policies.guard';
import { CheckAbility } from '../../casl/check-ability.decorator';
import {
  ParametrosService,
  type ParametrosFacturacion,
} from './parametros.service';
import { ActualizarParametrosDto } from './dto/actualizar-parametros.dto';

@Controller('parametros-facturacion')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class ParametrosController {
  constructor(private readonly parametros: ParametrosService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  findOne(): Promise<ParametrosFacturacion> {
    return this.parametros.findOne();
  }

  @Patch()
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  update(@Body() dto: ActualizarParametrosDto): Promise<ParametrosFacturacion> {
    return this.parametros.update(dto);
  }
}
