-- VoiceForge: Agent Generation + Multi-CRM + Twilio Adapter
-- Migration: 0031_voiceforge_agent_gen

-- CRM Credentials (workspace-level, encrypted API keys)
CREATE TABLE workspace_crm_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('pipedrive', 'hubspot', 'salesforce', 'generic_webhook')),
  credentials JSONB NOT NULL,
  config JSONB,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('active', 'invalid', 'pending')),
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, provider)
);

-- CRM Routing Rules (keyword-based multi-CRM fan-out)
CREATE TABLE crm_routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  keyword VARCHAR(100) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('primary', 'secondary')),
  priority INT DEFAULT 100,
  contact_mapping JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_crm_routing_workspace ON crm_routing_rules(workspace_id);
CREATE INDEX idx_crm_routing_agent ON crm_routing_rules(agent_id) WHERE agent_id IS NOT NULL;

-- CRM Fan-out Audit Log
CREATE TABLE crm_fanout_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  contact_data JSONB NOT NULL,
  fanout_results JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_crm_fanout_call ON crm_fanout_log(call_id);

-- Twilio Phone Numbers
CREATE TABLE twilio_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  type VARCHAR(20) DEFAULT 'local' CHECK (type IN ('local', 'tollfree', 'byo')),
  twilio_sid VARCHAR(100),
  inbound_webhook_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'active',
  cost_per_month NUMERIC(6,2) DEFAULT 1.15,
  provisioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_twilio_workspace ON twilio_phone_numbers(workspace_id);
CREATE INDEX idx_twilio_agent ON twilio_phone_numbers(agent_id) WHERE agent_id IS NOT NULL;

-- Outbound Campaigns
CREATE TABLE outbound_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  name VARCHAR(200) NOT NULL,
  contacts JSONB NOT NULL DEFAULT '[]',
  schedule JSONB NOT NULL DEFAULT '{"max_calls_per_hour": 10, "max_concurrent": 3}',
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'completed', 'failed')),
  stats JSONB DEFAULT '{"total": 0, "completed": 0, "failed": 0, "in_progress": 0}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_campaign_workspace ON outbound_campaigns(workspace_id);
CREATE INDEX idx_campaign_agent ON outbound_campaigns(agent_id);

