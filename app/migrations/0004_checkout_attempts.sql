-- Per-key checkout attempt counters for the lightweight abuse throttle (app/src/domain/throttle.ts):
-- one row per payment link or portal member, reset on an atomic UPSERT once its window has elapsed.
CREATE TABLE checkout_attempts (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX checkout_attempts_window ON checkout_attempts(window_start);
