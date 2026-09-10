/**
 * The "first user becomes the admin" rule, in one place.
 *
 * A brand-new local-only deployment has nobody who could issue an invite code,
 * so `/api/v1/auth/register` waives the invite requirement for the very first
 * account and marks it admin. `/api/v1/auth/config` publishes the same verdict
 * so the register form can drop its invite field instead of blocking on a code
 * that cannot exist yet.
 *
 * Those two endpoints computing the condition separately is exactly how the UI
 * ended up demanding an invite the API did not want (issue #7), hence one
 * exported predicate rather than two inline copies.
 */
export type BootstrapInput = {
  /** Accounts already in the database. */
  totalUsers: number;
  /** `FIRST_USER_IS_ADMIN` — operator opt-out for the whole mechanism. */
  firstUserIsAdmin: boolean;
  /** How many ids `LINUXDO_ADMIN_IDS` names. */
  adminIdCount: number;
};

/**
 * True while the next account to register would become the bootstrap admin.
 *
 * Requires an empty database (this is a one-shot, not a standing exemption) and
 * no configured admin — with `LINUXDO_ADMIN_IDS` set, the operator has already
 * said who is in charge and nothing should self-promote past them.
 */
export function canBootstrapFirstAdmin(input: BootstrapInput): boolean {
  return (
    input.totalUsers === 0 &&
    input.firstUserIsAdmin &&
    input.adminIdCount === 0
  );
}
