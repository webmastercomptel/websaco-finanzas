// src/common/tenant/tenant-context.service.ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ACTIVE_COPROPERTY_KEY } from './tenant-context.constants';

/**
 * Resolves the effective tenant (coproperty) for the current request.
 *
 * The ONLY trustworthy source is CLS, populated per request from the
 * `X-CoProperty-Id` header AFTER the caller's assignment has been validated.
 * A client-supplied explicit id (e.g. a `?coPropertyId=` query param) is NOT
 * trusted: it may only echo the already-validated active tenant, and any
 * mismatch is a cross-tenant attempt. Callers should prefer the no-argument
 * form.
 *
 * There is deliberately NO fallback to "the first coproperty in the database"
 * when the context is empty. A default tenant is a cross-tenant leak wearing a
 * helpful face: it turns a request that should have failed into one that
 * quietly returns someone else's money. An empty context is an error.
 */
@Injectable()
export class TenantContextService {
  constructor(private readonly cls: ClsService) {}

  /**
   * Returns the active coproperty as an `ObjectId`, ready to drop into a query.
   *
   * An ObjectId and not a string, and this is not a matter of taste: the
   * driver does not coerce a string into an ObjectId when matching this field,
   * so a filter built with the string form matches **nothing**. It returns an
   * empty list rather than an error — the worst possible failure, because the
   * screen reads "this building has no units" for a building with sixty of
   * them, and nobody suspects the query.
   *
   * Converting here rather than at each call site is the point: the tenancy law
   * says every query starts from this value, so this is the one place that can
   * guarantee the value is usable.
   *
   * @param explicitId Optional id supplied by the client. Accepted only when it
   * matches the validated active tenant exactly.
   * @throws ForbiddenException when there is no active tenant, or when
   * `explicitId` does not match it.
   */
  resolveCoPropertyId(explicitId?: string): Types.ObjectId {
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

    if (!Types.ObjectId.isValid(active)) {
      // Unreachable through the guard, which validates the id before writing
      // it. Kept so a future writer of this context cannot introduce a value
      // that would surface far away as a CastError inside somebody's query.
      throw new ForbiddenException('La copropiedad activa no es válida');
    }

    return new Types.ObjectId(active);
  }

  /**
   * The active coproperty as the string it was received as, or `undefined` when
   * the request has no tenant.
   *
   * For the rare caller that must branch on absence instead of failing — an
   * endpoint that lets somebody pick one, a log line. Never build a database
   * query from this: a string does not match the stored reference. That is what
   * `resolveCoPropertyId()` is for.
   */
  activeCoPropertyIdOrNull(): string | undefined {
    return this.cls.get<string | undefined>(ACTIVE_COPROPERTY_KEY);
  }
}
