// src/modules/factura-publica/factura-publica.controller.ts
import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import { Public } from '../casl/check-ability.decorator';
import { ObtenerFacturaPublicaDto } from './dto/obtener-factura-publica.dto';
import { EnlaceFacturaService } from './enlace-factura.service';
import {
  FORMATO_TOKEN,
  MENSAJE_OPACO,
  PISO_DE_TIEMPO_MS,
} from './factura-publica.constantes';
import { esperarPisoDeTiempo } from './piso-de-tiempo';

/** Attempts per client address and per token, per window. `req.ip` is the real
 *  client only because `configureApp` trusts exactly TRUST_PROXY_HOPS proxies.
 *  There is deliberately NO global bucket: one counting every request would let
 *  anyone lock every recipient out. */
const LIMITE_POR_IP = 30;
const LIMITE_POR_TOKEN = 10;
const VENTANA_MS = 60_000;

/** Sent on EVERY answer of this route, success or refusal: the page is a
 *  personal document behind a bearer link, never to be cached, indexed,
 *  sniffed or leaked through a `Referer`. */
const CABECERAS_DE_SEGURIDAD = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

/** The file name comes from the invoice number alone, reduced to a safe set. */
function nombreDeArchivo(numeroCompleto: string): string {
  const seguro = numeroCompleto.replace(/[^A-Za-z0-9-]+/g, '-');
  const recortado = seguro.replace(/^-+|-+$/g, '');
  return recortado ? `factura-${recortado}.pdf` : 'factura.pdf';
}

/**
 * Opens ONE invoice PDF for whoever holds the emailed link, with no account.
 * Public by necessity (the recipient has no session) and single purpose: a
 * token in, the bytes of that token's invoice page out. It lists nothing,
 * returns no JSON on success and exposes no second route.
 *
 * Order, so nothing is revealed early: body shape (the only 400, handled by
 * the global pipe) -> per-IP limit (429) -> token format -> per-token limit
 * (429) -> the service's checks. EVERY other failure is the same 404 with one
 * fixed message, answered no sooner than `PISO_DE_TIEMPO_MS`, so neither the
 * status, the body, the headers nor the timing say which check refused. The
 * limiter fails closed. The tenant is the link's own; this route reads no
 * header, cookie or tenant context.
 *
 * Logging: the service logs refusals with the link id and an internal reason;
 * this controller logs only a successful serve (link id and send id). Never
 * the token, its hash, an address or the IP.
 */
@Controller('publico/facturas')
export class FacturaPublicaController {
  private readonly logger = new Logger(FacturaPublicaController.name);

  constructor(
    private readonly enlaces: EnlaceFacturaService,
    private readonly limite: LimiteIntentosService,
  ) {}

  @Post('pdf')
  @HttpCode(200)
  @Public()
  async obtenerPdf(
    @Body() dto: ObtenerFacturaPublicaDto,
    @Req() req: { ip?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const inicio = Date.now();
    // Set before anything can throw, so a refusal and a 429 carry them too.
    res.set(CABECERAS_DE_SEGURIDAD);

    const ip = req.ip ?? 'desconocida';
    if (
      !(await this.limite.permitir(
        `limite:factura-publica:ip:${ip}`,
        LIMITE_POR_IP,
        VENTANA_MS,
      ))
    ) {
      throw this.demasiadosIntentos();
    }

    // A malformed string is covered by the IP counter alone: it never creates
    // a per-token key.
    if (!FORMATO_TOKEN.test(dto.token)) return this.rechazar(inicio);

    const hashDelToken = createHash('sha256').update(dto.token).digest('hex');
    if (
      !(await this.limite.permitir(
        `limite:factura-publica:token:${hashDelToken}`,
        LIMITE_POR_TOKEN,
        VENTANA_MS,
      ))
    ) {
      throw this.demasiadosIntentos();
    }

    let resuelto: Awaited<ReturnType<EnlaceFacturaService['resolver']>> = null;
    try {
      resuelto = await this.enlaces.resolver(dto.token);
    } catch {
      // The service never throws; if it ever does, the answer is still the
      // opaque one and the message (which may name an invoice) goes nowhere.
      resuelto = null;
    }
    if (!resuelto) return this.rechazar(inicio);

    this.logger.log(
      `enlace ${resuelto.enlaceId} servido (envío ${resuelto.envioFacturaId})`,
    );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${nombreDeArchivo(resuelto.numeroCompleto)}"`,
    });
    res.send(Buffer.from(resuelto.bytes));
  }

  private async rechazar(inicio: number): Promise<never> {
    await esperarPisoDeTiempo(inicio, PISO_DE_TIEMPO_MS);
    throw new NotFoundException(MENSAJE_OPACO);
  }

  private demasiadosIntentos(): HttpException {
    return new HttpException(
      'Demasiados intentos. Espera un minuto e inténtalo de nuevo.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
