/**
 * Expiry arithmetic for the server-side session store, kept free of the
 * database so the fail-closed boundary conditions are cheap to test directly.
 */

interface SessionLike {
  cookie?: {
    // A Date on the way in; an ISO string on the way back out of jsonb.
    expires?: Date | string | null;
  };
}

export function resolveExpiresAt(session: SessionLike, now: Date, ttlMs: number): Date {
  const ceiling = new Date(now.getTime() + ttlMs);
  const claimed = session.cookie?.expires;
  if (!claimed) {
    return ceiling;
  }

  const parsed = claimed instanceof Date ? claimed : new Date(claimed);
  if (Number.isNaN(parsed.getTime())) {
    return ceiling;
  }

  // The ttl is an absolute cap. A cookie that claims a longer life is clamped
  // so no request path can quietly extend a session past eight hours.
  return parsed.getTime() > ceiling.getTime() ? ceiling : parsed;
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  const expiry = expiresAt.getTime();
  if (Number.isNaN(expiry)) {
    return true;
  }
  return expiry <= now.getTime();
}
