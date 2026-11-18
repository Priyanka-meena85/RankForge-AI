ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS checkout_attempt_key TEXT,
  ADD COLUMN IF NOT EXISTS checkout_plan TEXT,
  ADD COLUMN IF NOT EXISTS checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_subscriptions_checkout_attempt_key_idx
  ON workspace_subscriptions(checkout_attempt_key);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_subscriptions_checkout_session_id_idx
  ON workspace_subscriptions(checkout_session_id);
