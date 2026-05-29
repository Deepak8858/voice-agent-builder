-- VoiceForge LiveKit BYO telephony: provider connections, generic phone numbers, LiveKit SIP routing, webhook idempotency.

ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "phone_number_id" UUID,
  ADD COLUMN IF NOT EXISTS "livekit_room_name" TEXT,
  ADD COLUMN IF NOT EXISTS "livekit_participant_id" TEXT;

CREATE TABLE IF NOT EXISTS "telephony_provider_connections" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "display_name" TEXT NOT NULL,
  "provider_account_id" TEXT,
  "encrypted_credentials" JSONB NOT NULL,
  "credential_version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'connected',
  "last_verified_at" TIMESTAMP(3),
  "last_sync_at" TIMESTAMP(3),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "telephony_phone_numbers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider_connection_id" UUID REFERENCES "telephony_provider_connections"("id") ON DELETE SET NULL,
  "provider" TEXT NOT NULL,
  "provider_number_id" TEXT,
  "phone_number_e164" TEXT NOT NULL UNIQUE,
  "friendly_name" TEXT,
  "capabilities_json" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending_verification',
  "assigned_agent_id" UUID REFERENCES "agents"("id") ON DELETE SET NULL,
  "inbound_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "outbound_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "last_synced_at" TIMESTAMP(3),
  "provider_metadata_json" JSONB,
  "sip_trunk_id" TEXT,
  "verification_token" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "livekit_telephony_configs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "phone_number_id" UUID NOT NULL UNIQUE REFERENCES "telephony_phone_numbers"("id") ON DELETE CASCADE,
  "agent_id" UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "livekit_room_prefix" TEXT NOT NULL,
  "livekit_sip_host" TEXT NOT NULL,
  "inbound_trunk_id" TEXT,
  "outbound_trunk_id" TEXT,
  "dispatch_rule_id" TEXT,
  "sip_auth_username_encrypted" JSONB,
  "sip_auth_password_encrypted" JSONB,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "telephony_webhook_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "phone_number_id" UUID REFERENCES "telephony_phone_numbers"("id") ON DELETE SET NULL,
  "call_id" UUID,
  "raw_payload_json" JSONB NOT NULL,
  "signature_valid" BOOLEAN NOT NULL DEFAULT FALSE,
  "processed_at" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'received',
  "error_message" TEXT,
  "workspace_id" UUID REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telephony_webhook_events_provider_event_id_key" UNIQUE ("provider", "event_id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'calls_phone_number_id_fkey'
  ) THEN
    ALTER TABLE "calls"
      ADD CONSTRAINT "calls_phone_number_id_fkey"
      FOREIGN KEY ("phone_number_id") REFERENCES "telephony_phone_numbers"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "calls_phone_number_id_idx" ON "calls"("phone_number_id");
CREATE INDEX IF NOT EXISTS "telephony_provider_connections_workspace_id_provider_idx" ON "telephony_provider_connections"("workspace_id", "provider");
CREATE INDEX IF NOT EXISTS "telephony_provider_connections_organization_id_idx" ON "telephony_provider_connections"("organization_id");
CREATE INDEX IF NOT EXISTS "telephony_phone_numbers_workspace_id_provider_idx" ON "telephony_phone_numbers"("workspace_id", "provider");
CREATE INDEX IF NOT EXISTS "telephony_phone_numbers_organization_id_idx" ON "telephony_phone_numbers"("organization_id");
CREATE INDEX IF NOT EXISTS "telephony_phone_numbers_provider_connection_id_idx" ON "telephony_phone_numbers"("provider_connection_id");
CREATE INDEX IF NOT EXISTS "telephony_phone_numbers_assigned_agent_id_idx" ON "telephony_phone_numbers"("assigned_agent_id");
CREATE INDEX IF NOT EXISTS "livekit_telephony_configs_workspace_id_status_idx" ON "livekit_telephony_configs"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "livekit_telephony_configs_organization_id_idx" ON "livekit_telephony_configs"("organization_id");
CREATE INDEX IF NOT EXISTS "livekit_telephony_configs_agent_id_idx" ON "livekit_telephony_configs"("agent_id");
CREATE INDEX IF NOT EXISTS "telephony_webhook_events_phone_number_id_idx" ON "telephony_webhook_events"("phone_number_id");
CREATE INDEX IF NOT EXISTS "telephony_webhook_events_call_id_idx" ON "telephony_webhook_events"("call_id");
CREATE INDEX IF NOT EXISTS "telephony_webhook_events_workspace_id_idx" ON "telephony_webhook_events"("workspace_id");
CREATE INDEX IF NOT EXISTS "telephony_webhook_events_provider_event_type_idx" ON "telephony_webhook_events"("provider", "event_type");

ALTER TABLE "telephony_provider_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "telephony_phone_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "livekit_telephony_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "telephony_webhook_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telephony_provider_connections_workspace_read"
  ON public.telephony_provider_connections FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
  ));

CREATE POLICY "telephony_provider_connections_workspace_write"
  ON public.telephony_provider_connections FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    AND wm.role IN ('owner', 'admin', 'editor')
  ))
  WITH CHECK (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    AND wm.role IN ('owner', 'admin', 'editor')
  ));

CREATE POLICY "telephony_phone_numbers_workspace_read"
  ON public.telephony_phone_numbers FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
  ));

CREATE POLICY "telephony_phone_numbers_workspace_write"
  ON public.telephony_phone_numbers FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    AND wm.role IN ('owner', 'admin', 'editor')
  ))
  WITH CHECK (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    AND wm.role IN ('owner', 'admin', 'editor')
  ));

CREATE POLICY "livekit_telephony_configs_workspace_read"
  ON public.livekit_telephony_configs FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
  ));

CREATE POLICY "livekit_telephony_configs_workspace_write"
  ON public.livekit_telephony_configs FOR ALL
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    AND wm.role IN ('owner', 'admin', 'editor')
  ))
  WITH CHECK (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
    AND wm.role IN ('owner', 'admin', 'editor')
  ));

CREATE POLICY "telephony_webhook_events_workspace_read"
  ON public.telephony_webhook_events FOR SELECT
  USING (workspace_id IN (
    SELECT w.id FROM public.workspaces w
    JOIN public.workspace_memberships wm ON wm.workspace_id = w.id
    JOIN public.users u ON u.id = wm.user_id
    WHERE u.auth_user_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid
  ));

CREATE POLICY "telephony_webhook_events_insert"
  ON public.telephony_webhook_events FOR INSERT
  WITH CHECK (true);
