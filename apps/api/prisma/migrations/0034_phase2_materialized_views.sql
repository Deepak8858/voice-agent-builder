-- Phase 2: Materialized Views for Usage & Analytics
-- Pre-computed aggregations for 100k user scale
-- Refresh hourly via pg_cron

-- Monthly workspace usage aggregation
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_workspace_usage_monthly AS
SELECT
  workspace_id,
  date_trunc('month', period_start) as period,
  billable_metric,
  SUM(quantity) as total_quantity,
  COUNT(*) as record_count
FROM usage_records
GROUP BY workspace_id, date_trunc('month', period_start), billable_metric;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_workspace_usage_monthly
  ON mv_workspace_usage_monthly(workspace_id, period, billable_metric);

-- Agent daily stats for dashboard
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agent_stats_daily AS
SELECT
  agent_id,
  date_trunc('day', occurred_at) as day,
  event_type,
  COUNT(*) as count
FROM analytics_events
WHERE occurred_at > now() - interval '90 days'
GROUP BY agent_id, date_trunc('day', occurred_at), event_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_agent_stats_daily
  ON mv_agent_stats_daily(agent_id, day, event_type);

-- Call outcome stats for compliance monitoring
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_call_outcomes_daily AS
SELECT
  agent_id,
  date_trunc('day', created_at) as day,
  outcome,
  direction,
  COUNT(*) as total_calls,
  AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL) as avg_duration_seconds
FROM calls
WHERE created_at > now() - interval '90 days'
GROUP BY agent_id, date_trunc('day', created_at), outcome, direction;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_call_outcomes_daily
  ON mv_call_outcomes_daily(agent_id, day, outcome, direction);

-- Schedule hourly refresh (run as superuser)
-- SELECT cron.schedule('refresh-analytics-mv', '0 * * * *',
--   $$SELECT refresh_analytics_mv()$$);

-- Refresh function
CREATE OR REPLACE FUNCTION refresh_analytics_mv()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_workspace_usage_monthly;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_agent_stats_daily;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_call_outcomes_daily;
END;
$$ LANGUAGE plpgsql;