// src/modules/configuracion/documentos/documentos.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../../casl/policies.guard';
import { CheckAbility } from '../../casl/check-ability.decorator';
import { DocumentosService } from './documentos.service';
import type { CrearConsecutivoDto } from './dto/crear-consecutivo.dto';
import type { ActualizarConsecutivoDto } from './dto/actualizar-consecutivo.dto';
import type { CrearResolucionDto } from './dto/crear-resolucion.dto';
import type { ActualizarResolucionMetadataDto } from './dto/actualizar-resolucion-metadata.dto';
import type { DocumentoAdmin, ResolucionAdmin } from '../../../contracts';
import type { CategoriaDocumento } from '../../../database/schemas/numeracion/consecutivo-documento.schema';

@Controller('documentos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class DocumentosController {
  constructor(private readonly documentos: DocumentosService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  findAll(): Promise<{
    items: DocumentoAdmin[];
    resolucion: ResolucionAdmin | null;
  }> {
    return this.documentos.findAll();
  }

  @Post('consecutivos/:categoria')
  @CheckAbility({ action: 'create', subject: 'Configuracion' })
  crearConsecutivo(
    @Param('categoria') categoria: CategoriaDocumento,
    @Body() dto: CrearConsecutivoDto,
  ): Promise<DocumentoAdmin> {
    return this.documentos.crearConsecutivo(categoria, dto);
  }

  @Patch('consecutivos/:codigo')
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  updateConsecutivo(
    @Param('codigo') codigo: string,
    @Body() dto: ActualizarConsecutivoDto,
  ): Promise<DocumentoAdmin> {
    return this.documentos.updateConsecutivo(codigo, dto);
  }

  @Post('resolucion')
  @CheckAbility({ action: 'create', subject: 'Configuracion' })
  crearResolucion(@Body() dto: CrearResolucionDto): Promise<ResolucionAdmin> {
    return this.documentos.crearResolucion(dto);
  }

  @Patch('resolucion')
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  actualizarResolucionMetadata(
    @Body() dto: ActualizarResolucionMetadataDto,
  ): Promise<ResolucionAdmin> {
    return this.documentos.actualizarResolucionMetadata(dto);
  }
}
