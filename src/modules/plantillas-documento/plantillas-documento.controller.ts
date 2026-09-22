// src/modules/plantillas-documento/plantillas-documento.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { PlantillaDocumentoService } from '../../common/documentos/plantilla-documento.service';
import {
  TIPOS_DOCUMENTO_PRESENTACION,
  type TipoDocumentoPresentacion,
} from '../../database/schemas/documentos/presentacion-documento.schema';
import { ActualizarPlantillaDocumentoDto } from './dto/actualizar-plantilla-documento.dto';
import { toPlantilla } from './plantillas-documento.mapper';
import type { PlantillaDocumento } from '../../contracts';

/**
 * The platform's catalogue of pdfmake templates, one per document type.
 *
 * `PlatformAdminGuard`, not `PoliciesGuard`/`@CheckAbility`: these rows are
 * global across every coproperty this system serves (mirrors
 * `EntidadesController`'s own reasoning) — no customer administrator, however
 * senior, has any business editing a template every other client's documents
 * also render from.
 *
 * No `POST`: the six-row set is fixed by `TIPOS_DOCUMENTO_PRESENTACION`, so
 * there is never a "new" template to create, only an existing slot to
 * upsert via `PUT`.
 */
@Controller('plantillas-documento')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class PlantillasDocumentoController {
  constructor(private readonly plantillas: PlantillaDocumentoService) {}

  @Get()
  async findAll(): Promise<PlantillaDocumento[]> {
    const documentos = await this.plantillas.findAll();
    return documentos.map(toPlantilla);
  }

  @Get(':tipoDocumento')
  async findOne(
    @Param('tipoDocumento') tipoDocumento: string,
  ): Promise<PlantillaDocumento> {
    const tipo = this.validarTipo(tipoDocumento);
    const documento = await this.plantillas.findOne(tipo);
    return toPlantilla(documento);
  }

  @Put(':tipoDocumento')
  async upsert(
    @Param('tipoDocumento') tipoDocumento: string,
    @Body() dto: ActualizarPlantillaDocumentoDto,
  ): Promise<PlantillaDocumento> {
    const tipo = this.validarTipo(tipoDocumento);
    const documento = await this.plantillas.upsert(tipo, dto.docDefinition);
    return toPlantilla(documento);
  }

  /**
   * Rejects a route param outside the fixed six-type enum with a clear 400
   * instead of letting it fall through to a Mongo enum-validation error on
   * `PUT` (opaque 500) or a silent "not found" on `GET` (a caller who
   * mistyped the code would see the same response as one asking for a type
   * that's simply missing its template).
   */
  private validarTipo(valor: string): TipoDocumentoPresentacion {
    if (
      !TIPOS_DOCUMENTO_PRESENTACION.includes(valor as TipoDocumentoPresentacion)
    ) {
      throw new BadRequestException(
        `Tipo de documento inválido: ${valor}. Debe ser uno de ${TIPOS_DOCUMENTO_PRESENTACION.join(', ')}`,
      );
    }
    return valor as TipoDocumentoPresentacion;
  }
}
