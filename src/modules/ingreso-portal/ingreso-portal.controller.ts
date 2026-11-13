// src/modules/ingreso-portal/ingreso-portal.controller.ts
import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseInterceptors,
} from '@nestjs/common';
import { CabecerasDeSeguridadInterceptor } from '../../common/publico/cabeceras-de-seguridad.interceptor';
import { esperarPisoDeTiempo } from '../../common/publico/piso-de-tiempo';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import type { CanjeIngresoPortal } from '../../contracts';
import { Public } from '../casl/check-ability.decorator';
import { CanjearIngresoDto } from './dto/canjear-ingreso.dto';
import { SolicitarIngresoDto } from './dto/solicitar-ingreso.dto';
import {
  clavesLimite,
  FORMATO_TOKEN_INGRESO,
  LIMITES_INGRESO,
  MENSAJE_CANJE_INVALIDO,
  MENSAJE_DEMASIADOS_INTENTOS,
  MENSAJE_SOLICITUD,
  PISO_CANJE_MS,
  PISO_SOLICITUD_MS,
} from './ingreso-portal.constantes';
import { IngresoPortalService } from './ingreso-portal.service';

/**
 * The two public routes of the resident sign-in. Public by necessity (the
 * person has no session yet), single purpose, and built so that no answer says
 * anything about WHO is on a record:
 *
 * - `POST solicitar`: whatever the address is (known, unknown, revoked,
 *   malformed, over its own limit, mail off, a failing database) the answer is
 *   the same 202, with the same headers, at the SAME time: the work is started
 *   without being awaited and the reply leaves on the 1,500 ms clock, so a slow
 *   provider cannot be measured. The only variable answer is the 429 of the
 *   per-IP limit, which does not depend on the address.
 * - `POST canjear`: the explicit redeem (nothing is consumed by opening a page
 *   or by a GET; no GET route reads a token). Every refusal is the same 401,
 *   never sooner than 300 ms.
 *
 * Order, so nothing is revealed early: body shape (the only 400, handled by the
 * global pipe) -> per-IP limit (429, fails closed) -> the rest. There is
 * deliberately NO global bucket: one counting every request would let anyone
 * lock every resident out. `req.ip` is the real client only because
 * `configureApp` trusts exactly TRUST_PROXY_HOPS proxies.
 *
 * The security headers of every answer, the 400 included, come from
 * `CabecerasDeSeguridadInterceptor`. This class logs nothing: never an address,
 * a token, a hash, the IP or a body.
 */
@Controller('auth/portal')
@UseInterceptors(CabecerasDeSeguridadInterceptor)
export class IngresoPortalController {
  constructor(
    private readonly servicio: IngresoPortalService,
    private readonly limite: LimiteIntentosService,
  ) {}

  @Post('solicitar')
  @HttpCode(202)
  @Public()
  async solicitar(
    @Body() dto: SolicitarIngresoDto,
    @Req() req: { ip?: string },
  ): Promise<{ mensaje: string }> {
    const inicio = Date.now();

    const { solicitudPorIp } = LIMITES_INGRESO;
    if (
      !(await this.limite.permitir(
        clavesLimite.solicitudIp(req.ip),
        solicitudPorIp.limite,
        solicitudPorIp.ventanaMs,
      ))
    ) {
      throw this.demasiadosIntentos();
    }

    // Started, never awaited: its duration must not reach the client. The
    // service catches its own errors; the `catch` is only a seatbelt so a bug
    // there can never become an unhandled rejection or a different answer.
    void this.servicio.solicitar(dto.correo, req.ip).catch(() => undefined);

    await esperarPisoDeTiempo(inicio, PISO_SOLICITUD_MS);
    return { mensaje: MENSAJE_SOLICITUD };
  }

  @Post('canjear')
  @HttpCode(200)
  @Public()
  async canjear(
    @Body() dto: CanjearIngresoDto,
    @Req() req: { ip?: string },
  ): Promise<CanjeIngresoPortal> {
    const inicio = Date.now();

    const { canjePorIp, canjePorToken } = LIMITES_INGRESO;
    if (
      !(await this.limite.permitir(
        clavesLimite.canjeIp(req.ip),
        canjePorIp.limite,
        canjePorIp.ventanaMs,
      ))
    ) {
      throw this.demasiadosIntentos();
    }

    // A malformed string is covered by the IP counter alone: it never creates
    // a per-token key.
    if (!FORMATO_TOKEN_INGRESO.test(dto.token)) return this.rechazar(inicio);

    const hashDelToken = createHash('sha256').update(dto.token).digest('hex');
    if (
      !(await this.limite.permitir(
        clavesLimite.canjeToken(hashDelToken),
        canjePorToken.limite,
        canjePorToken.ventanaMs,
      ))
    ) {
      throw this.demasiadosIntentos();
    }

    let resultado: CanjeIngresoPortal | null = null;
    try {
      resultado = await this.servicio.canjear(dto.token);
    } catch {
      // The service never throws; if it ever does, the answer is still the
      // opaque one and the message goes nowhere.
      resultado = null;
    }
    if (!resultado) return this.rechazar(inicio);
    return resultado;
  }

  private async rechazar(inicio: number): Promise<never> {
    await esperarPisoDeTiempo(inicio, PISO_CANJE_MS);
    throw new UnauthorizedException(MENSAJE_CANJE_INVALIDO);
  }

  private demasiadosIntentos(): HttpException {
    return new HttpException(
      MENSAJE_DEMASIADOS_INTENTOS,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
