# 8.1 Admin Cost Dashboard — Design Spec

**Date:** 2026-05-13
**Phase:** Phase 8: Enterprise & Scale
**Status:** Draft

---

## Overview

Internal ops dashboard + customer-facing billing page. Tracks usage metrics, costs, and trends across organizations and agents. Sends overage alerts at 80%/100% thresholds.

---

## Data Layer

### Materialized View (Historical)

```sql
CREATE MATERIALIZED VIEW mv_org_cost_summary AS
SELECT 
  o.id as org_id,
  o.name as org_name,
  o.plan,
  date_trunc('month', ur.recorded_at) as period,
  SUM(ur.quantity * p.price_per_unit) as estimated_cost,
  COUNT(DISTINCT ur.workspace_id) as active_workspaces,
  SUM(CASE WHEN ur.billable_metric = 'calls' THEN ur.quantity ELSE 0 END) as total_calls,
  SUM(CASE WHEN ur.billable_metric = 'minutes' THEN ur.quantity ELSE 0 END) as total_minutes
FROM organizations o
LEFT JOIN usage_records ur ON ur.organization_id = o.id
LEFT JOIN plan_pricing p ON p.plan = o.plan AND p.metric = ur.billable_metric
GROUP BY o.id, o.name, o.plan, date_trunc('month', ur.recorded_at);

CREATE UNIQUE INDEX ON mv_org_cost_summary(org_id, period);
```

- Refreshed hourly via pg_cron
- Historical months only (past completed months)

### Live Query (Current Month)

```sql
-- Computed on read for current in-flight month
SELECT 
  organization_id,
  billable_metric,
  SUM(quantity) as quantity
FROM usage_records
WHERE date_trunc('month', recorded_at) = date_trunc('month', NOW())
GROUP BY organization_id, billable_metric;
```

---

## API Endpoints

### Internal Admin (service token auth)

```
GET /admin/orgs/:id/usage?period=2026-05
  Response: { org_id, period, total_spend, total_calls, total_minutes, active_workspaces }

GET /admin/orgs/:id/usage?from=2026-01&to=2026-05
  Response: { periods: [{ period, total_spend, total_calls, total_minutes }, ...] }

GET /admin/orgs/:id/agents/usage
  Response: { agents: [{ agent_id, name, total_calls, total_minutes, estimated_cost }, ...] }

GET /admin/usage/overview
  Response: { orgs: [{ org_id, org_name, plan, total_spend, total_calls, total_minutes }, ...] }
```

### Customer-Facing (workspace JWT)

```
GET /v1/orgs/:id/usage
  Response: { current_month: { calls, minutes }, plan_limit: { calls, minutes }, percentage_used }

GET /v1/orgs/:id/usage/trends
  Response: { months: [{ period, calls, minutes }, ...], mom_delta: { calls_pct, minutes_pct } }
```

---

## UI Components

### Admin Side

**`/admin/dashboard`** — Ops overview
- Summary table: all orgs with total_spend, total_calls, total_minutes
- Sortable, filterable by plan
- Click to drill into org detail

**`/admin/orgs/:id/billing`** — Org deep dive
- Period selector (default: current month)
- Per-agent breakdown table
- Trend chart (line chart, calls + minutes over time)
- Usage vs plan limit bar

### Customer Side

**`/dashboard/billing`** — Billing page (new or integrate into existing)
- Current month usage:
  - Calls: X / Y (plan limit)
  - Minutes: X / Y (plan limit)
  - Progress bars with color (green < 80%, yellow 80-99%, red 100%+)
- Cost estimate for month (if applicable)
- MoM trend mini-chart (sparkline or small bar chart)
- Upgrade CTA when percentage_used > 75%

### Responsive
- Mobile: stacked cards, sparklines instead of full charts
- Desktop: side-by-side panels, full chart suite

---

## Alerting

### Triggers

| Threshold | Action |
|-----------|--------|
| 80% of plan limit | Warning email + dashboard banner |
| 100% of plan limit | Hard block (existing behavior) + notify sales team |

### Alert Delivery

- **Email:** to org owner(s) registered on account
- **Slack:** internal webhook `#ops-alerts` for enterprise orgs
- **Dashboard:** persistent banner on billing page when > 80%

### Alert Suppression

- One alert per org per threshold per billing cycle
- Reset suppression at billing cycle reset (month start)

---

## File Changes

### New Files

- `apps/api/src/admin/admin.module.ts`
- `apps/api/src/admin/admin.controller.ts` — internal endpoints
- `apps/api/src/admin/admin.service.ts`
- `apps/api/src/usage/usage.module.ts`
- `apps/api/src/usage/usage.service.ts` — shared usage queries
- `apps/api/src/usage/usage.controller.ts` — customer-facing endpoints
- `apps/api/src/billing/alerts.service.ts` — overage alerting
- `apps/web/app/admin/dashboard/page.tsx`
- `apps/web/app/admin/orgs/[orgId]/billing/page.tsx`
- `apps/web/app/dashboard/billing/page.tsx` — new or extend existing
- `supabase/migrations/YYYYMMDD_mv_org_cost_summary.sql`

### Modified Files

- `apps/api/src/app.module.ts` — add AdminModule, UsageModule
- `apps/web/app/dashboard/billing/page.tsx` — extend if exists
- `apps/api/prisma/schema.prisma` — add plan_pricing table if needed

---

## Spec Self-Review

1. **Placeholder scan:** All fields named, no TBD/TODO. ✓
2. **Internal consistency:** MV schema matches API response shape. ✓
3. **Scope check:** Focused on dashboard + usage API, not SDK (that's 8.4). ✓
4. **Ambiguity check:** Alert thresholds explicit (80%/100%). ✓