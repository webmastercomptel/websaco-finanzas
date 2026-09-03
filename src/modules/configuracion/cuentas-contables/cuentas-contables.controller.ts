// src/modules/configuracion/cuentas-contables/cuentas-contables.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../../casl/policies.guard';
import { CheckAbility } from '../../casl/check-ability.decorator';
import { CuentasContablesService } from './cuentas-contables.service';
import { ListarCuentasDto } from './dto/listar-cuentas.dto';
import { ActualizarCuentaDto, CrearCuentaDto } from './dto/guardar-cuenta.dto';
import type { CuentaContableContract, Paginado } from '../../../contracts';

@Controller('cuentas-contables')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class CuentasContablesController {
  constructor(private readonly cuentas: CuentasContablesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  findAll(
    @Query() query: ListarCuentasDto,
  ): Promise<Paginado<CuentaContableContract>> {
    return this.cuentas.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  findOne(@Param('id') id: string): Promise<CuentaContableContract> {
    return this.cuentas.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Configuracion' })
  create(@Body() dto: CrearCuentaDto): Promise<CuentaContableContract> {
    return this.cuentas.create(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarCuentaDto,
  ): Promise<CuentaContableContract> {
    return this.cuentas.update(id, dto);
  }
}
