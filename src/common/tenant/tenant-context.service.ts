// src/common/tenant/tenant-context.service.ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ACTIVE_COPROPERTY_KEY } from './tenant-context.constants';

/**
 * Resolves the effective tenant (coproperty) for the current request.
 *
 * The ONLY trustworthy source is CLS, populated per request from the
 * `X-CoProperty-Id` header AFTER the caller's membership has been validated.
 * A client-supplied explicit id (e.g. a `?coPropertyId=` query param) is NOT
 * trusted: it may only echo the already-validated active tenant, and any
 * mismatch is a cross-tenant attempt. Callers should prefer the no-argument
 * form.
 *
 * There is deliberately NO fallback to "the first coproperty in the database"
 * when the context is empty. A default tenant is a cross-tenant leak wearing a
 * helpful face: it turns a request that should have failed into one that
 * quietly returns someone else's money. An empty context is an error.
 *
 * It returns a plain `string` for now. Whether the stored field becomes an
 * ObjectId reference to the local coproperty collection is settled together
 * with the schemas, in the data-model change — if it is promoted, this
 * signature is the one place that has to follow.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService) {}

  /**
   * Returns the active coproperty id.
   *
   * @param explicitId Optional id supplied by the client. Accepted only when it
   * matches the validated active tenant exactly.
   * @throws ForbiddenException when there is no active tenant, or when
   * `explicitId` does not match it.
   */
  resolveCoPropertyId(explicitId?: string): string {
    const active = this.cls.get<string | undefined>(ACTIVE_COPROPERTY_KEY);

    if (!active) {
      // Fail closed. Reaching here means the request was never scoped to a
      // tenant — serving it would leak across coproperties.
      throw new ForbiddenException(
        'No hay una copropiedad activa para esta petición',
      );
    }

    // SECURITY: a client-supplied id may never widen access. It can only
    // confirm the tenant that was already validated for this request.
    if (explicitId && explicitId !== active) {
      throw new ForbiddenException('No pertenecés a esta copropiedad');
    }

    return active;
  }

  /**
   * Returns the active coproperty id, or `undefined` when the request has no
   * tenant. For the rare caller that must branch on absence instead of failing
   * (e.g. an endpoint that lets the user pick a coproperty). Never use this to
   * build a database query — that is what `resolveCoPropertyId()` is for.
   */
  activeCoPropertyIdOrNull(): string | undefined {
    return this.cls.get<string | undefined>(ACTIVE_COPROPERTY_KEY);
  }
}
