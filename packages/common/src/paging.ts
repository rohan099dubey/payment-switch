/**
 * Opaque page tokens for keyset pagination (ADR-027). A token carries the sort key of the
 * last row returned, e.g. `[created_at as Postgres text, reference_id, operation]`. The
 * timestamp travels as Postgres text, never as a JS `Date`, so its microseconds survive
 * and no row is skipped or repeated at a millisecond boundary.
 */
export function encodePageToken(key: readonly string[]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** The sort key inside a token, or null when the token is malformed or has the wrong arity. */
export function decodePageToken(token: string, arity: number): string[] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== arity) return null;
    const parts: unknown[] = parsed;
    return parts.every((part): part is string => typeof part === 'string') ? parts : null;
  } catch {
    return null;
  }
}

/** The page sizes ADR-027 allows: 1..1000, with 0 meaning the maximum. Null when invalid. */
export function pageSize(requested: number, max = 1000): number | null {
  if (!Number.isInteger(requested) || requested < 0 || requested > max) return null;
  return requested === 0 ? max : requested;
}
