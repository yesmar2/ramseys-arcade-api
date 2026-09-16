/**
 * How much of a board to send, and from where.
 *
 * Boards keep every score now, so depth is the caller's business: the first
 * page is what lands on first paint, and the rest arrives as someone scrolls
 * down. The ceiling here is about the size of one response, not about what
 * exists — `total` on the reply is what says how far down it goes.
 */
const MAX_PAGE = 500

export function pageParams(
  query: Record<string, unknown>,
  fallback = 100,
): { limit: number; offset: number } {
  const limitRaw = Number(query.limit ?? fallback)
  const offsetRaw = Number(query.offset ?? 0)
  return {
    limit: Number.isFinite(limitRaw)
      ? Math.min(MAX_PAGE, Math.max(1, Math.floor(limitRaw)))
      : fallback,
    offset: Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0,
  }
}
