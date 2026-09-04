// src/modules/auth/auth.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AccesoService } from '../../common/acceso/acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { AuthMe } from '../../contracts';

@Controller('auth')
export class AuthController {
  constructor(private readonly acceso: AccesoService) {}

  /**
   * Who am I, and which coproperties may I work on.
   *
   * Guarded by authentication only — deliberately no `@CheckAbility`. Asking
   * who you are is not a privilege: a caller with zero permissions still needs
   * an answer, otherwise the app cannot tell "your session expired" apart from
   * "you have no access yet" and shows the wrong screen for both.
   *
   * It also must not require an active coproperty, since its answer is what
   * lets the caller pick one. Nothing here reads the tenant, so that holds by
   * construction — keep it that way.
   */
  @Get('me')
  @UseGuards(FirebaseAuthGuard)
  async me(@CurrentUser() user: IRequestUser): Promise<AuthMe> {
    // No local account means no assignments to look up, and asking anyway
    // would be a query whose answer is known.
    const esAdministradorPlataforma = user.isPlatformAdmin === true;
    const copropiedades = user.accountId
      ? await this.acceso.copropiedadesDe(
          user.accountId,
          esAdministradorPlataforma,
        )
      : [];
    // A platform administrator's own flag already says enough; no need to
    // also look up an assignment they don't need.
    const alcance =
      user.accountId && !esAdministradorPlataforma
        ? await this.acceso.alcancePrimarioDe(user.accountId)
        : null;

    return {
      uid: user.uid,
      email: user.email,
      nombre: user.nombre ?? null,
      esAdministradorPlataforma,
      copropiedades: copropiedades.map((c) => ({
        id: c.coPropertyId,
        codigo: c.codigo,
        nombre: c.nombre,
      })),
      alcance,
    };
  }
}
