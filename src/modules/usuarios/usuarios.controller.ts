// src/modules/usuarios/usuarios.controller.ts
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
import { UsuariosService } from './usuarios.service';
import { ListarUsuariosDto } from './dto/listar-usuarios.dto';
import {
  ActualizarUsuarioDto,
  CrearUsuarioDto,
} from './dto/guardar-usuario.dto';
import type { Usuario, Paginado } from '../../contracts';

/**
 * The platform's user roster — who may sign in, and where. Mirrors "Usuarios"
 * in the "Instalación" panel of the system this replaces.
 *
 * `PlatformAdminGuard`, same reasoning as Entidades/Copropiedades: deciding
 * who else may operate the system is not a permission any of those operators
 * could hold for themselves.
 *
 * This is the one controller whose POST and PATCH reach Firebase — see
 * FirebaseUsuariosService for the narrow, deliberate exception to "never
 * write to Firebase" that makes this screen possible. No DELETE: a user is
 * retired via `PATCH { estado: 'inactivo' }`, which disables the Firebase
 * identity immediately (see the service) without erasing who they were.
 */
@Controller('usuarios')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class UsuariosController {
  constructor(private readonly usuarios: UsuariosService) {}

  @Get()
  findAll(@Query() query: ListarUsuariosDto): Promise<Paginado<Usuario>> {
    return this.usuarios.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Usuario> {
    return this.usuarios.findOne(id);
  }

  @Post()
  create(@Body() dto: CrearUsuarioDto): Promise<Usuario> {
    return this.usuarios.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarUsuarioDto,
  ): Promise<Usuario> {
    return this.usuarios.update(id, dto);
  }
}
