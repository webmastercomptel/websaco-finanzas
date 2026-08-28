// src/common/interfaces/request-user.interface.ts

/**
 * The authenticated caller, attached to the request by the auth guard and read
 * by PoliciesGuard and the services. The guard that populates it does not exist
 * yet — this interface is the contract it will have to satisfy, and what the
 * authorization layer is already written against.
 *
 * Note that authorization in Finanzas is entirely its own: the permission keys
 * below are financial ("facturas.anular"), resolved from this system's roles.
 * Membership in a coproperty is a separate question, answered by the system
 * that owns the catalog.
 */
export interface IRequestUser {
  /** Identity-provider uid. */
  uid: string;
  email: string;
  /** Mongo `_id` of the local Account (undefined when not provisioned yet). */
  accountId?: string;
  /** Display name, used to stamp authorship on financial documents. */
  nombre?: string;
  /** Platform root: bypasses ability checks entirely. */
  isPlatformAdmin?: boolean;
  /** The active coproperty for this request (from X-CoProperty-Id). */
  coPropertyId?: string;
  /** Role ids backing the permissions below. */
  roleIds?: string[];
  /** Union of permission keys (`modulo.accion`) across the caller's roles. */
  permissions?: string[];
}
