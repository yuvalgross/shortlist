// Reading is capped at 5 minutes on the server. If an upload still says "parsing" well past that, the
// function was stopped before it could record a failure, and the user should be offered a retry.
export const STUCK_AFTER_MS = 6 * 60 * 1000;

export function parseLooksStuck(
  upload: { parse_status: string; parse_started_at: string | null; created_at: string },
  now: number = Date.now(),
): boolean {
  if (upload.parse_status !== "parsing") return false;
  const startedAt = Date.parse(upload.parse_started_at ?? upload.created_at);
  return Number.isFinite(startedAt) && now - startedAt > STUCK_AFTER_MS;
}
