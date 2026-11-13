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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { UsuariosService } from './usuarios.service';
import { AsignacionesUsuarioService } from './asignaciones-usuario.service';
import { ListarUsuariosDto } from './dto/listar-usuarios.dto';
import {
  ActualizarUsuarioDto,
  CrearUsuarioDto,
} from './dto/guardar-usuario.dto';
import {
  ActualizarAsignacionUsuarioDto,
  AgregarAsignacionUsuarioDto,
} from './dto/guardar-asignacion-usuario.dto';
import { PERMISOS_FINANZAS } from '../casl/permisos-catalogo';
import type { PermisosFinanzas, Usuario, Paginado } from '../../contracts';

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
  constructor(
    private readonly usuarios: UsuariosService,
    private readonly asignacionesUsuario: AsignacionesUsuarioService,
  ) {}

  @Get()
  findAll(@Query() query: ListarUsuariosDto): Promise<Paginado<Usuario>> {
    return this.usuarios.findAll(query);
  }

  /**
   * The Finanzas keys that exist for real, so the matrix does not draw a
   * checkbox for a pair no route checks. Static vocabulary, no query. Declared
   * before `:id` so the path is never read as an id.
   */
  @Get('permisos-finanzas')
  permisosFinanzas(): PermisosFinanzas {
    return { claves: [...PERMISOS_FINANZAS] };
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Usuario> {
    return this.usuarios.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CrearUsuarioDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Usuario> {
    return this.usuarios.create(dto, {
      accountId: user.accountId!,
      nombre: user.nombre ?? user.email,
    });
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarUsuarioDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Usuario> {
    return this.usuarios.update(id, dto, {
      accountId: user.accountId!,
      nombre: user.nombre ?? user.email,
    });
  }

  /**
   * Adds ONE assignment to the account. The person's other rows are never read
   * or changed (the assignments add up). Answers with the whole `Usuario`, read
   * after the write, so the detail screen re-renders from one object.
   */
  @Post(':id/asignaciones')
  async agregarAsignacion(
    @Param('id') id: string,
    @Body() dto: AgregarAsignacionUsuarioDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Usuario> {
    await this.asignacionesUsuario.agregar(id, dto, {
      accountId: user.accountId!,
      nombre: user.nombre ?? user.email,
    });
    return this.usuarios.findOne(id);
  }

  /** Edits the keys and/or the state of ONE assignment row of the account. */
  @Patch(':id/asignaciones/:asignacionId')
  async actualizarAsignacion(
    @Param('id') id: string,
    @Param('asignacionId') asignacionId: string,
    @Body() dto: ActualizarAsignacionUsuarioDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Usuario> {
    await this.asignacionesUsuario.actualizar(id, asignacionId, dto, {
      accountId: user.accountId!,
      nombre: user.nombre ?? user.email,
    });
    return this.usuarios.findOne(id);
  }
}
