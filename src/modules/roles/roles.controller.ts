// src/modules/roles/roles.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import type { Permiso, Rol } from '../../contracts';
import { ActualizarRolDto, CrearRolDto } from './dto/guardar-rol.dto';
import { RolesService } from './roles.service';

/**
 * Roles of the active coproperty: named bundles of permissions of any offered
 * module (Finanzas and Administración keys alike). Each verb asks for its own
 * action: `roles.ver` (read) opens the two reads and nothing else;
 * `roles.gestionar` (manage) covers all of them. Which keys a caller may put in
 * a role, or take out of one, is the delegation cap in the service ("you give
 * only what you hold"), not this controller's business; every write receives
 * the caller so it can be judged and audited. `GET /roles/permisos` still lists
 * the Administración catalog only.
 */
@Controller('roles')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Rol' })
  findAll(): Promise<Rol[]> {
    return this.roles.findAll();
  }

  /** Declared before any `:id` route so the path is never read as an id. */
  @Get('permisos')
  @CheckAbility({ action: 'read', subject: 'Rol' })
  permisos(): Permiso[] {
    return this.roles.permisos();
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Rol' })
  create(
    @Body() dto: CrearRolDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Rol> {
    return this.roles.create(dto, user);
  }

  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Rol' })
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarRolDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Rol> {
    return this.roles.update(id, dto, user);
  }

  @Delete(':id')
  @CheckAbility({ action: 'remove', subject: 'Rol' })
  remove(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<{ id: string }> {
    return this.roles.remove(id, user);
  }
}
