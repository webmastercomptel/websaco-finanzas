import { Controller, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { NotasCreditoService } from './notas-credito.service';

/**
 * `subject: 'NotaCredito'` throughout, `create`/`read`/`update`/`annul` per
 * action — same one-subject-for-the-whole-lifecycle choice `RecibosController`
 * made (design §5). `NotaCredito`/`create`/`read`/`update`/`annul` are
 * already registered in `casl-ability.constants.ts` and `permission-map.ts`
 * (verified, no CASL code changes needed for this module — `approve` is
 * deliberately never checked, design §2). Routes land in Tasks 6–9.
 */
@Controller('notas-credito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasCreditoController {
  constructor(private readonly notasCredito: NotasCreditoService) {}
}
