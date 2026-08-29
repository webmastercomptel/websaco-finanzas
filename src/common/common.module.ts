// src/common/common.module.ts
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { ClsModule } from 'nestjs-cls';
import { redisProvider } from './redis/redis.provider';
import { REDIS_CLIENT } from './redis/redis.constants';
import { firebaseAuthProvider } from './firebase/firebase.provider';
import { FIREBASE_AUTH } from './firebase/firebase.constants';
import { FirebaseUsuariosService } from './firebase/firebase-usuarios.service';
import { FirebaseAuthGuard } from './guards/firebase-auth.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { TenantContextService } from './tenant/tenant-context.service';
import { AccesoService } from './acceso/acceso.service';
import { CuentaService } from './cuentas/cuenta.service';
import { NumeracionService } from './numeracion/numeracion.service';
import { PeriodoService } from './contabilidad/periodo.service';

/**
 * Global module for cross-cutting providers: the shared Redis client, the
 * Firebase Auth instance, the auth guard and the tenant context.
 *
 * ClsModule provides the per-request store where FirebaseAuthGuard publishes
 * the active coproperty, so TenantContextService can read it anywhere in the
 * request without threading it through every call.
 */
@Global()
@Module({
  imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } })],
  providers: [
    redisProvider,
    firebaseAuthProvider,
    FirebaseAuthGuard,
    PlatformAdminGuard,
    FirebaseUsuariosService,
    TenantContextService,
    AccesoService,
    CuentaService,
    NumeracionService,
    PeriodoService,
  ],
  exports: [
    REDIS_CLIENT,
    FIREBASE_AUTH,
    FirebaseAuthGuard,
    PlatformAdminGuard,
    FirebaseUsuariosService,
    TenantContextService,
    AccesoService,
    CuentaService,
    NumeracionService,
    PeriodoService,
  ],
})
export class CommonModule implements OnApplicationShutdown {
  private readonly logger = new Logger(CommonModule.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Closes the Redis connection when the app shuts down.
   *
   * Without this the socket stays open, the event loop never drains, and the
   * process simply never exits. A server is usually killed anyway so it goes
   * unnoticed there; a script that finishes its work and then hangs at the
   * prompt makes it obvious, and looks like the work failed when it did not.
   *
   * It matters in production too: a container that will not exit on SIGTERM
   * gets killed on a timeout instead of shutting down cleanly.
   *
   * `quit()` first, so the server is told. If the link is already broken that
   * would hang waiting for a reply that cannot come, hence the fallback —
   * shutdown must not be able to block on a connection that is already gone.
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.redis.quit();
    } catch (err) {
      this.logger.warn(
        `Cierre ordenado de Redis falló (${(err as Error).message}); se corta la conexión.`,
      );
      this.redis.disconnect();
    }
  }
}
