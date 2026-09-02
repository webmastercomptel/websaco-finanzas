// src/modules/copropiedades/copropiedades.controller.ts
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
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CopropiedadesService } from './copropiedades.service';
import { ListarCopropiedadesDto } from './dto/listar-copropiedades.dto';
import {
  ActualizarCopropiedadDto,
  CrearCopropiedadDto,
} from './dto/guardar-copropiedad.dto';
import type { Copropiedad, Paginado } from '../../contracts';

/**
 * The platform's catalogue of coproperties — the tenants themselves. Mirrors
 * "Copropiedades" in the "Instalación" panel of the system this replaces.
 *
 * `PlatformAdminGuard`, not `PoliciesGuard`: a coproperty IS the unit of
 * tenancy, so there is no per-building permission a customer's administrator
 * could hold to edit the definition of their own building or anyone else's.
 *
 * No DELETE: a coproperty is retired via `PATCH { estado: 'inactivo' }`, which
 * stops it being billed and keeps every document ever issued against it
 * readable.
 */
@Controller('copropiedades')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class CopropiedadesController {
  constructor(private readonly copropiedades: CopropiedadesService) {}

  @Get()
  findAll(
    @Query() query: ListarCopropiedadesDto,
  ): Promise<Paginado<Copropiedad>> {
    return this.copropiedades.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Copropiedad> {
    return this.copropiedades.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CrearCopropiedadDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Copropiedad> {
    return this.copropiedades.create(dto, {
      accountId: user.accountId!,
      nombre: user.nombre ?? user.email,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarCopropiedadDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Copropiedad> {
    return this.copropiedades.update(id, dto, {
      accountId: user.accountId!,
      nombre: user.nombre ?? user.email,
    });
  }
}
