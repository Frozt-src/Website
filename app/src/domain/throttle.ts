// Lightweight abuse control for checkout POSTs. No CAPTCHA: a payment-link token is 32 random bytes
// (see app/README.md), which already makes the link itself infeasible to brute force, so this only
// has to slow down someone hammering a *known* link or a signed-in member's own checkout endpoint.
export const checkoutAttemptLimit = 10;
export const checkoutAttemptWindowSeconds = 600;

// One atomic UPSERT owns the quota decision, including concurrent requests — the same
// insert-or-update-with-window-reset pattern the inquiry API's rate limiter uses (api/src/index.ts),
// parameterized here instead of the fixed 5-per-hour limit that one hardcodes. A row whose window
// closed over a day ago is swept once per call: nothing else purges this table.
export async function allowCheckoutAttempt(
  db: D1Database,
  now: number,
  key: string,
  limit = checkoutAttemptLimit,
  windowSeconds = checkoutAttemptWindowSeconds,
): Promise<boolean> {
  const windowResetAt = now - windowSeconds;
  const quota = await db
    .prepare(`INSERT INTO checkout_attempts (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN checkout_attempts.window_start <= ? THEN 1 ELSE checkout_attempts.count + 1 END,
        window_start = CASE WHEN checkout_attempts.window_start <= ? THEN excluded.window_start ELSE checkout_attempts.window_start END
      WHERE checkout_attempts.window_start <= ? OR checkout_attempts.count < ?
      RETURNING count`)
    .bind(key, now, windowResetAt, windowResetAt, windowResetAt, limit)
    .first<{ count: number }>();
  await db.prepare(`DELETE FROM checkout_attempts WHERE window_start < ?`).bind(now - 86400).run();
  return quota !== null;
}
