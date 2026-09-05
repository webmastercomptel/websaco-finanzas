// src/modules/catalogos/catalogos.service.ts
import { Injectable } from '@nestjs/common';
import {
  CIUDADES_DIAN,
  DEPARTAMENTOS_DIAN,
  TIPOS_IDENTIFICACION_DIAN,
  type CiudadDian,
  type DepartamentoDian,
  type TipoIdentificacionDian,
} from './catalogos.data';

/**
 * Read-only access to the static DIAN/DANE catalogs — no tenant, no writes,
 * so this is the one service in the app with no `TenantContextService` and
 * no Mongo model. `listarCiudades` is the only method that takes an
 * argument at all, and only to narrow a 1123-row list to one department's.
 */
@Injectable()
export class CatalogosService {
  listarTiposIdentificacion(): TipoIdentificacionDian[] {
    return TIPOS_IDENTIFICACION_DIAN;
  }

  listarDepartamentos(): DepartamentoDian[] {
    return DEPARTAMENTOS_DIAN;
  }

  listarCiudades(departamentoCodigo?: string): CiudadDian[] {
    if (!departamentoCodigo) return CIUDADES_DIAN;
    return CIUDADES_DIAN.filter(
      (c) => c.departamentoCodigo === departamentoCodigo,
    );
  }
}
