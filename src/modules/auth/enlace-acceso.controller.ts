// src/modules/auth/enlace-acceso.controller.ts
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import type { EnlaceCanjeado } from '../../contracts';
import { Public } from '../casl/check-ability.decorator';
import { CanjearEnlaceDto } from './dto/canjear-enlace.dto';

/** Attempts per client address per window. */
const LIMITE_POR_IP = 20;
/** Attempts across every client per window: bounds the cost if addresses rotate. */
const LIMITE_GLOBAL = 600;
const VENTANA_MS = 60_000;

/**
 * Redeems an emailed access link. Public by necessity (the person following the
 * link has no session yet), and single purpose: it exchanges a link token for a
 * Firebase custom token of the link's account plus the link's same-site landing
 * path. It reads and writes no Firebase user and returns nothing else about the
 * account.
 *
 * Contract for the frontend route `/auth/enlace?token=…` (Stage 5): POST the
 * token here, call `signInWithCustomToken(customToken)`, select
 * `copropiedadId` as the active coproperty, then navigate to `destino`.
 *
 * Rate-limited per client address and globally (Redis, fails closed). Every
 * failure — unknown, expired, revoked, or an account that no longer qualifies —
 * is the same 401, so the route cannot be used to probe which tokens exist.
 */
@Controller('auth')
export class EnlaceAccesoController {
  constructor(
    private readonly enlaces: EnlaceAccesoService,
    private readonly limite: LimiteIntentosService,
  ) {}

  @Post('enlace/canjear')
  @HttpCode(200)
  @Public()
  async canjear(
    @Body() dto: CanjearEnlaceDto,
    @Req() req: { ip?: string },
  ): Promise<EnlaceCanjeado> {
    const ip = req.ip ?? 'desconocida';
    const porIp = await this.limite.permitir(
      `limite:enlace-canjear:ip:${ip}`,
      LIMITE_POR_IP,
      VENTANA_MS,
    );
    const global = await this.limite.permitir(
      'limite:enlace-canjear:global',
      LIMITE_GLOBAL,
      VENTANA_MS,
    );
    if (!porIp || !global) {
      throw new HttpException(
        'Demasiados intentos. Espera un minuto e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const canje = await this.enlaces.canjear(dto.token);
    if (!canje) {
      throw new UnauthorizedException('El enlace no es válido o venció');
    }
    return canje;
  }
}
