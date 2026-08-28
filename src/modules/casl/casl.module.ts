// src/modules/casl/casl.module.ts
import { Global, Module } from '@nestjs/common';
import { CaslAbilityFactory } from './casl-ability.factory';
import { PoliciesGuard } from './policies.guard';

/**
 * Global so any controller can list PoliciesGuard in its UseGuards and inject
 * CaslAbilityFactory without re-importing this module.
 */
@Global()
@Module({
  providers: [CaslAbilityFactory, PoliciesGuard],
  exports: [CaslAbilityFactory, PoliciesGuard],
})
export class CaslModule {}
