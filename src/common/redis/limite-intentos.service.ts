// src/common/redis/limite-intentos.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// INCR and set the window's expiry on the first hit, atomically: a counter left
// without a TTL would lock the key out forever. Works on any Redis version
// (no `PEXPIRE ... NX`, which needs Redis 7).
const CONTAR_SCRIPT = `
local n = redis.call("incr", KEYS[1])
if n == 1 then redis.call("pexpire", KEYS[1], ARGV[1]) end
return n`;

/**
 * Fixed-window attempt counter on the shared Redis client, for the few public
 * routes (today only the access-link redeem). A Nest guard would not do: the
 * route-policy inventory requires a `@Public()` route to carry no guards, and
 * the project has no throttling package.
 *
 * Fails CLOSED: if Redis does not answer, the attempt is refused. A public
 * sign-in route that stops limiting when its limiter is down is the exact
 * moment someone would hammer it.
 */
@Injectable()
export class LimiteIntentosService {
  private readonly logger = new Logger(LimiteIntentosService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Counts one attempt under `clave` and answers whether it is still within
   * `limite` attempts for the current window of `ventanaMs`.
   */
  async permitir(
    clave: string,
    limite: number,
    ventanaMs: number,
  ): Promise<boolean> {
    try {
      const intentos = Number(
        await this.redis.eval(CONTAR_SCRIPT, 1, clave, String(ventanaMs)),
      );
      if (!Number.isFinite(intentos)) return false;
      return intentos <= limite;
    } catch (error: unknown) {
      // Only the key's family (everything before its last `:`): the last
      // segment is an IP, a hash or a token digest, none of which belongs in a log.
      const familia = clave.slice(0, Math.max(clave.lastIndexOf(':'), 0));
      this.logger.error(
        `No se pudo contar el intento ${familia}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
