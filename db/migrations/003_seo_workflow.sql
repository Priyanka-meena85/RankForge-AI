CREATE TABLE IF NOT EXISTS content_batches (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  vertical TEXT NOT NULL CHECK (char_length(vertical) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'generating', 'ready', 'completed')),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

ALTER TABLE workspace_topics ADD COLUMN IF NOT EXISTS batch_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_topics_batch_workspace_fk'
  ) THEN
    ALTER TABLE workspace_topics
      ADD CONSTRAINT workspace_topics_batch_workspace_fk
      FOREIGN KEY (workspace_id, batch_id) REFERENCES content_batches(workspace_id, id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS content_batches_listing_idx
  ON content_batches(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_topics_batch_idx
  ON workspace_topics(workspace_id, batch_id, status);

CREATE TABLE IF NOT EXISTS workspace_content_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  product_description TEXT NOT NULL DEFAULT '' CHECK (char_length(product_description) <= 4000),
  approved_cta TEXT NOT NULL DEFAULT '' CHECK (char_length(approved_cta) <= 300),
  minimum_word_count INTEGER NOT NULL DEFAULT 700 CHECK (minimum_word_count BETWEEN 300 AND 5000),
  minimum_faqs INTEGER NOT NULL DEFAULT 5 CHECK (minimum_faqs BETWEEN 1 AND 8),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS seo_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS quality_report JSONB;
ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS quality_checked_at TIMESTAMPTZ;
ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS ai_repair_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS published_url TEXT;
ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE workspace_drafts ADD COLUMN IF NOT EXISTS wordpress_post_id BIGINT;

CREATE TABLE IF NOT EXISTS workspace_ai_usage (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL,
  draft_id UUID,
  usage_month DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed')),
  reservation_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, topic_id) REFERENCES workspace_topics(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, draft_id) REFERENCES workspace_drafts(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_ai_usage_active_topic_idx
  ON workspace_ai_usage(workspace_id, topic_id, usage_month)
  WHERE status IN ('reserved', 'completed');
CREATE INDEX IF NOT EXISTS workspace_ai_usage_quota_idx
  ON workspace_ai_usage(workspace_id, usage_month, status, reservation_expires_at);

CREATE TABLE IF NOT EXISTS workspace_ai_suggestion_limits (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (workspace_id, usage_date)
);

CREATE TABLE IF NOT EXISTS workspace_integrations (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  wordpress_site_url TEXT,
  wordpress_username TEXT,
  wordpress_app_password_encrypted TEXT,
  google_refresh_token_encrypted TEXT,
  google_site_url TEXT,
  ga4_property_id TEXT,
  google_connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_google_oauth_states_expiry_idx
  ON workspace_google_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS workspace_publications (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL,
  draft_version INTEGER NOT NULL CHECK (draft_version > 0),
  wordpress_post_id BIGINT,
  url TEXT,
  status TEXT NOT NULL CHECK (status IN ('publishing', 'published', 'failed')),
  error_code TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, draft_id, draft_version),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES workspace_drafts(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_page_metrics (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  draft_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  ctr DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (ctr >= 0),
  average_position DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (average_position >= 0),
  sessions INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, draft_id, period_start, period_end),
  FOREIGN KEY (workspace_id, draft_id) REFERENCES workspace_drafts(workspace_id, id) ON DELETE CASCADE,
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS workspace_page_metrics_listing_idx
  ON workspace_page_metrics(workspace_id, period_end DESC);
