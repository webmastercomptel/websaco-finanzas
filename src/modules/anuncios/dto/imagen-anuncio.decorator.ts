// src/modules/anuncios/dto/imagen-anuncio.decorator.ts
import { applyDecorators } from '@nestjs/common';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/** Longest image URL accepted; browsers and proxies choke well before this anyway. */
export const LONGITUD_MAXIMA_IMAGEN = 2048;

/**
 * Validation of an announcement's `imagen`: an absolute `https:` URL (no
 * credentials, no spaces, at most {@link LONGITUD_MAXIMA_IMAGEN} characters),
 * or `null`/omitted for "no image". The value is a free URL that the portal and
 * the panel put in an `<img src>`, so `javascript:`, `data:`, `http:` and
 * relative or protocol-relative forms are refused on every write. Rows stored
 * before this rule are not rewritten.
 */
export const ImagenAnuncio = (): PropertyDecorator =>
  applyDecorators(
    IsOptional(),
    IsString(),
    MaxLength(LONGITUD_MAXIMA_IMAGEN),
    IsUrl(
      { protocols: ['https'], require_protocol: true, disallow_auth: true },
      { message: 'imagen debe ser una URL https válida' },
    ),
  );
