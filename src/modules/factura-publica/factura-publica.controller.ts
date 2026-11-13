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
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import { Public } from '../casl/check-ability.decorator';
import { CabecerasDeSeguridadInterceptor } from '../../common/publico/cabeceras-de-seguridad.interceptor';
import { ObtenerFacturaPublicaDto } from './dto/obtener-factura-publica.dto';
import {
  EnlaceFacturaService,
  type ResumenFacturaPublica,
} from './enlace-factura.service';
import {
  FORMATO_TOKEN,
  MENSAJE_OPACO,
  PISO_DE_TIEMPO_MS,
} from './factura-publica.constantes';
import { esperarPisoDeTiempo } from '../../common/publico/piso-de-tiempo';
import { IngresoPortalService } from '../ingreso-portal/ingreso-portal.service';
import {
  MENSAJE_SOLICITUD,
  PISO_SOLICITUD_MS,
} from '../ingreso-portal/ingreso-portal.constantes';
import { segmentoIp } from '../../common/publico/segmento-ip';

/** Attempts per client address and per token, per window. `req.ip` is the real
 *  client only because `configureApp` trusts exactly TRUST_PROXY_HOPS proxies.
 *  There is deliberately NO global bucket: one counting every request would let
 *  anyone lock every recipient out. */
const LIMITE_POR_IP = 30;
const LIMITE_POR_TOKEN = 10;
const VENTANA_MS = 60_000;

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
 * header, cookie or tenant context. The security headers of every answer,
 * the 400 included, come from `CabecerasDeSeguridadInterceptor`.
 *
 * Logging: the service logs refusals with the link id and an internal reason;
 * this controller logs only a successful serve (link id and send id). Never
 * the token, its hash, an address or the IP.
 */
@Controller('publico/facturas')
@UseInterceptors(CabecerasDeSeguridadInterceptor)
export class FacturaPublicaController {
  private readonly logger = new Logger(FacturaPublicaController.name);

  constructor(
    private readonly enlaces: EnlaceFacturaService,
    private readonly limite: LimiteIntentosService,
    private readonly ingreso: IngresoPortalService,
  ) {}

  @Post('pdf')
  @HttpCode(200)
  @Public()
  async obtenerPdf(
    @Body() dto: ObtenerFacturaPublicaDto,
    @Req() req: { ip?: string },
  ): Promise<StreamableFile> {
    const inicio = Date.now();
    await this.pasarLimites(dto, req, inicio);

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
    // Returned, never written with `res.send`: Nest writes the handler's value
    // anyway, and the global envelope landed on an already-sent response
    // (ERR_HTTP_HEADERS_SENT, reported to Sentry). The envelope interceptor
    // lets a StreamableFile through untouched.
    return new StreamableFile(Buffer.from(resuelto.bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="${nombreDeArchivo(resuelto.numeroCompleto)}"`,
    });
  }

  /**
   * The fixed facts of the same invoice (number, unit, period, due date,
   * total), for the page to show above the PDF buttons. Same limits, same
   * refusals, same opaque 404 and time floor as the PDF; no live balance.
   */
  @Post('resumen')
  @HttpCode(200)
  @Public()
  async obtenerResumen(
    @Body() dto: ObtenerFacturaPublicaDto,
    @Req() req: { ip?: string },
  ): Promise<ResumenFacturaPublica> {
    const inicio = Date.now();
    await this.pasarLimites(dto, req, inicio);
    let resumen: ResumenFacturaPublica | null = null;
    try {
      resumen = await this.enlaces.resumen(dto.token);
    } catch {
      resumen = null;
    }
    if (!resumen) return this.rechazar(inicio);
    return resumen;
  }

  /**
   * «Entrar a mi portal» from the invoice page: asks for a portal sign-in link
   * for the ADDRESS this invoice link was sent to, without the person typing
   * it. The sign-in link is e-mailed to that address by the regular request
   * flow (`IngresoPortalService.solicitar`: same eligibility, counters and
   * e-mail), so forwarding the invoice e-mail gives nobody portal access.
   * After the shared limits, the answer is ALWAYS the request route's own
   * 202 at its fixed time, whatever the link or the address; the work runs
   * after it and never throws.
   */
  @Post('ingreso')
  @HttpCode(202)
  @Public()
  async pedirIngreso(
    @Body() dto: ObtenerFacturaPublicaDto,
    @Req() req: { ip?: string },
  ): Promise<{ mensaje: string }> {
    const inicio = Date.now();
    const formatoValido = await this.pasarLimites(dto, req, inicio, false);
    // Started, never awaited, never throws: nothing about the link reaches the answer.
    if (formatoValido) {
      void this.enlaces
        .correoDelEnlace(dto.token)
        .then((correo) =>
          correo ? this.ingreso.solicitar(correo, req.ip) : undefined,
        )
        .catch(() => undefined);
    }
    await esperarPisoDeTiempo(inicio, PISO_SOLICITUD_MS);
    return { mensaje: MENSAJE_SOLICITUD };
  }

  /**
   * The per-IP limit, the token format and the per-token limit, in that order.
   * A malformed token is the opaque 404 (`rechazarFormato`), or, for the
   * sign-in route, simply goes nowhere (its answer never varies).
   */
  private async pasarLimites(
    dto: ObtenerFacturaPublicaDto,
    req: { ip?: string },
    inicio: number,
    rechazarFormato = true,
  ): Promise<boolean> {
    // An IPv6 client counts as its /64 (`segmentoIp`).
    if (
      !(await this.limite.permitir(
        `limite:factura-publica:ip:${segmentoIp(req.ip)}`,
        LIMITE_POR_IP,
        VENTANA_MS,
      ))
    ) {
      throw this.demasiadosIntentos();
    }

    // A malformed string is covered by the IP counter alone: it never creates
    // a per-token key.
    if (!FORMATO_TOKEN.test(dto.token)) {
      if (rechazarFormato) await this.rechazar(inicio);
      return false;
    }

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
    return true;
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
