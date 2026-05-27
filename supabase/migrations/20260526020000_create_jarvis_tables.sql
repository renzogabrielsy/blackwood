-- ============================================================
-- Jarvis AI Chat — Foundation Tables
-- Created: 2026-05-26
-- ============================================================

-- ------------------------------------------------------------
-- 1. jarvis_conversations
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jarvis_conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title          text,                           -- auto-set from first message (max 80 chars), null until then
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  archived       boolean NOT NULL DEFAULT false
);

ALTER TABLE jarvis_conversations ENABLE ROW LEVEL SECURITY;

-- Users can only see/modify their own conversations
CREATE POLICY "jarvis_conversations_select_own"
  ON jarvis_conversations FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "jarvis_conversations_insert_own"
  ON jarvis_conversations FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "jarvis_conversations_update_own"
  ON jarvis_conversations FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "jarvis_conversations_delete_own"
  ON jarvis_conversations FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Index: list active conversations by user, newest first
CREATE INDEX IF NOT EXISTS idx_jarvis_conversations_active
  ON jarvis_conversations (user_id, last_message_at DESC)
  WHERE archived = false;


-- ------------------------------------------------------------
-- 2. jarvis_messages
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jarvis_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES jarvis_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content         text NOT NULL DEFAULT '',
  tool_calls      jsonb,    -- array of tool_use blocks the assistant emitted (nullable)
  tool_results    jsonb,    -- results from tool execution (nullable)
  created_at      timestamptz NOT NULL DEFAULT now(),
  position        int NOT NULL DEFAULT 0   -- monotonic per conversation for ordering ties
);

ALTER TABLE jarvis_messages ENABLE ROW LEVEL SECURITY;

-- RLS via conversation ownership: join-check would be expensive; use a security-definer helper
-- Instead, scope directly: users can only access messages in their own conversations
CREATE POLICY "jarvis_messages_select_own"
  ON jarvis_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM jarvis_conversations c
      WHERE c.id = conversation_id
      AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "jarvis_messages_insert_own"
  ON jarvis_messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM jarvis_conversations c
      WHERE c.id = conversation_id
      AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "jarvis_messages_update_own"
  ON jarvis_messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM jarvis_conversations c
      WHERE c.id = conversation_id
      AND c.user_id = auth.uid()
    )
  );

CREATE POLICY "jarvis_messages_delete_own"
  ON jarvis_messages FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM jarvis_conversations c
      WHERE c.id = conversation_id
      AND c.user_id = auth.uid()
    )
  );

-- Primary index: load messages for a conversation in order
CREATE INDEX IF NOT EXISTS idx_jarvis_messages_conv_pos
  ON jarvis_messages (conversation_id, position);


-- ------------------------------------------------------------
-- 3. jarvis_learnings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jarvis_learnings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type              text NOT NULL CHECK (type IN ('preference', 'pattern', 'correction')),
  content           text NOT NULL,
  source_message_id uuid REFERENCES jarvis_messages(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz
);

ALTER TABLE jarvis_learnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "jarvis_learnings_select_own"
  ON jarvis_learnings FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "jarvis_learnings_insert_own"
  ON jarvis_learnings FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "jarvis_learnings_update_own"
  ON jarvis_learnings FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "jarvis_learnings_delete_own"
  ON jarvis_learnings FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 4. pending_review
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_review (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_email_id       text NOT NULL,             -- Gmail thread/message ID for traceback
  source_attachment_id  text,                      -- Gmail attachment ID
  source_filename       text,                      -- e.g. "Daily Production Report 2026 2Q.xlsx"
  report_type           text NOT NULL,             -- 'daily_production', 'rc_deliveries', etc.
  received_at           timestamptz,               -- when the email arrived
  extracted_at          timestamptz NOT NULL DEFAULT now(),
  rows_json             jsonb NOT NULL,            -- array of ExtractedRow
  overall_confidence    numeric(4,3),              -- min(row.confidence) across all rows
  diagnostic_json       jsonb,                     -- agent notes: what it did, what it skipped
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected', 'manual_needed')),
  reviewed_at           timestamptz,
  reviewed_by           uuid REFERENCES profiles(id) ON DELETE SET NULL,
  final_rows_json       jsonb,                     -- actual JSON committed (may differ if Renzo edited)
  commit_audit_log_id   uuid REFERENCES audit_logs(id) ON DELETE SET NULL
);

ALTER TABLE pending_review ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can SELECT pending_review
CREATE POLICY "pending_review_select_authenticated"
  ON pending_review FOR SELECT
  TO authenticated
  USING (true);

-- Only admin/owner/dev can INSERT
CREATE POLICY "pending_review_insert_admin"
  ON pending_review FOR INSERT
  TO authenticated
  WITH CHECK (is_admin(auth.uid()));

-- Only admin/owner/dev can UPDATE (approve/reject)
CREATE POLICY "pending_review_update_admin"
  ON pending_review FOR UPDATE
  TO authenticated
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));

-- Only admin/owner/dev can DELETE
CREATE POLICY "pending_review_delete_admin"
  ON pending_review FOR DELETE
  TO authenticated
  USING (is_admin(auth.uid()));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pending_review_status_received
  ON pending_review (status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_review_source_email
  ON pending_review (source_email_id);   -- idempotency check: skip already-processed emails
