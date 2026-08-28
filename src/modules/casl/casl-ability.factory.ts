// src/modules/casl/casl-ability.factory.ts
import { Injectable } from '@nestjs/common';
import { createAppAbility } from './casl-ability.constants';
import type { AppAbility } from './casl-ability.constants';
import { rulesFromPermissionKeys } from './permission-map';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/** Builds the CASL ability for the authenticated caller. */
@Injectable()
export class CaslAbilityFactory {
  createForUser(
    user: Pick<IRequestUser, 'permissions' | 'isPlatformAdmin'>,
  ): AppAbility {
    return createAppAbility(
      rulesFromPermissionKeys(user.permissions ?? [], {
        platformAdmin: user.isPlatformAdmin,
      }),
    );
  }
}
