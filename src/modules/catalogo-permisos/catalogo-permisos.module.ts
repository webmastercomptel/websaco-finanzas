// src/modules/catalogo-permisos/catalogo-permisos.module.ts
import { Module } from '@nestjs/common';
import { CatalogoPermisosController } from './catalogo-permisos.controller';

/**
 * Serves the static permission vocabulary. Guards come from the @Global
 * CommonModule; there is no service and no model.
 */
@Module({ controllers: [CatalogoPermisosController] })
export class CatalogoPermisosModule {}
