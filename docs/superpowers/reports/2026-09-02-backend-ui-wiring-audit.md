# Backend ↔ UI wiring audit — 2026-09-02

Scope: `apps/api` (NestJS, global prefix `/api/v1`) vs `apps/web` (Next.js App Router). Read-only audit of the working tree on `design/voice-v2-rebuild`, which differs from `main` only by one spec markdown (`git diff main --stat`), so code findings apply to `main`.

Method: every `@Controller` + verb decorator was enumerated with line numbers; every web call site was enumerated via the two fetch helpers (`apps/web/lib/api.ts` server-side `apiFetch`, `apps/web/lib/use-api.ts` browser `useApi().call` → `/api/proxy/*`), plus raw `fetch('/api/...')` and `EventSource` uses. Browser calls are additionally gated by the proxy allowlist in `apps/web/lib/proxy-guards.ts:44-51` (`/auth/me`, `/workspaces`, `/templates`, `/invites/accept`, `/agents/generate`, `/users/me/erasure`) — anything outside those prefixes is unreachable from the browser even if a component tried.

## Summary

| Set | Count |
|---|---|
| Tenant-facing HTTP routes in `apps/api` | 130 |
| …with at least one web caller | 92 |
| …with **no** web caller (orphaned backend) | **38** |
| Routes not meant for the UI (`@InternalOnly()` 9, webhooks/public infra 13) | 22 |
| Distinct API paths the web calls that no controller serves | **0** |
| UI dead ends (broken link, orphan pages, dead components, hardcoded state, swallowed errors) | 8 |
| DTO fields returned but never rendered where it matters | 4 |

Every web-side path was checked against controller prefix + method path; all resolve. The bugs on the UI side are navigation/rendering dead ends, not bad API paths.

## 1. Backend without UI

Severity: HIGH = a paid-for / obviously expected capability the dashboard cannot reach; MEDIUM = useful but has a workaround or is niche; LOW = redundant, legacy, or ops-only.

| Route | Verb | Capability the customer cannot reach | Sev | Evidence |
|---|---|---|---|---|
| `workspaces/:ws/agents/:id/pause` | POST | Pause a published agent (stop it taking calls / spend). UI counts and filters "Paused" agents but has no way to pause one. | HIGH | `apps/api/src/agents/agents.controller.ts:154-163`; UI only reads status: `apps/web/app/dashboard/agents/page.tsx:71,78`, `apps/web/components/agents/agents-list-client.tsx:20`; no `/pause` call in web except campaigns |
| `workspaces/:ws/telephony/outbound-calls` | POST | Place a single outbound phone call from an agent ("call this number now" / call-me test). Only bulk CSV campaigns exist in UI. | HIGH | `apps/api/src/telephony/telephony.controller.ts:137-146`; DTO `packages/shared/src/schemas/telephony.ts:130-138`; grep `outbound-calls` in `apps/web` = 0 hits |
| `workspaces/:ws/agents/:id/calls/outbound` | POST | Same capability via the calls module (legacy provider path). | HIGH (dup of above) | `apps/api/src/calls/calls.controller.ts:56-67`; DTO `packages/shared/src/schemas/call.ts:23-30`; grep `calls/outbound` in web = 0 |
| `workspaces/:ws/calls/:id/end` | POST | Hang up an in-progress call from the dashboard. Call detail page shows live transcript but no End button; test drawer only disconnects the browser room. | MEDIUM | `apps/api/src/calls/calls.controller.ts:84-95`; `apps/web/app/dashboard/calls/[callId]/page.tsx` (no action besides back-link); `apps/web/components/test-call-drawer.tsx:56,66` (`room.disconnect()` only) |
| `workspaces/:ws/agents/:id` | PATCH | Rename an agent / edit description / industry. Builder page shows name but offers no edit. | MEDIUM | `apps/api/src/agents/agents.controller.ts:119-130`; DTO `packages/shared/src/schemas/agent.ts:24-28`; no `PATCH` to `/agents/` in web (grep `method: 'PATCH'` → campaigns, tools, retention, white-label only) |
| `workspaces/:ws/contacts/:id` | PATCH | Edit a contact's name/phone/metadata. Compliance panel can create, consent, revoke, opt-out — not edit. | MEDIUM | `apps/api/src/compliance/contacts.controller.ts:55-63`; `apps/web/components/compliance-panel.tsx` (only DELETE at 369, no PATCH) |
| `workspaces/me/contacts/:id/erasure` | DELETE | GDPR "erase this contact" (the DPA page promises erasure). Controller comment itself notes "Nothing in `apps/web` called the old path". | MEDIUM | `apps/api/src/compliance/erasure.controller.ts:45-64`; grep `erasure` in web → only `/users/me/erasure` (`apps/web/components/settings-panel.tsx:56`) |
| `workspaces/:ws/crm-routing/rules` | GET / POST | View/create keyword-based CRM routing rules. The CRM settings page has a "Routing Rules" tab whose only content is a link to a page that does not exist (see §2). Rules are created server-side by `orchestrator.worker`, so customers cannot even see them. | MEDIUM | `apps/api/src/crm-routing/crm-routing.controller.ts:16-35`; `apps/web/app/dashboard/settings/crm/page.tsx:294-298`; no `apps/web/app/dashboard/settings/crm/rules/page.tsx` |
| `workspaces/:ws/knowledge-sources/:id/reindex` | POST | Retry a failed/stale knowledge source. Panel renders `status` badge (incl. failed) but the only actions are upload/create/delete. | MEDIUM | `apps/api/src/knowledge/knowledge.controller.ts:168-215`; `apps/web/components/knowledge-panel.tsx:185` (badge), no `reindex` in web |
| `workspaces/:ws/phone-numbers/provision` | POST | Buy a new Twilio number by area code from the platform. Phone Numbers page only imports numbers from the customer's own Twilio/Vobiz account, adds manual, or SIP. (Voice V2 plans to drop Twilio, so value may be moot.) | MEDIUM | `apps/api/src/phone-numbers/phone-numbers.controller.ts:32-49`; `apps/web/app/dashboard/settings/phone-numbers/page.tsx` — grep `-e provision -e buy -e purchase` = 0 |
| `workspaces/:ws` | PATCH | Rename a workspace. Settings panel has only "Account Information" and "Delete account". | MEDIUM | `apps/api/src/workspaces/workspaces.controller.ts:31-44`; `apps/web/components/settings-panel.tsx:115,133` |
| `referrals` (POST, POST `accept`, GET, GET `:workspaceId`) | 4 routes | Referral program — zero UI, zero mentions in `apps/web`, and `/referrals` is **not** in the proxy allowlist so no browser page could reach it without a proxy change. | MEDIUM | `apps/api/src/referral/referral.controller.ts:37-80`; `apps/web/lib/proxy-guards.ts:44-51`; grep -i `referral` in web = 0 |
| `workspaces/:ws/knowledge-sources/:id` | PATCH | Rename/retitle a knowledge source (must delete + re-upload today). | LOW | `apps/api/src/knowledge/knowledge.controller.ts:132-147` |
| `workspaces/:ws/knowledge-sources/:id` | GET | Single-source detail (list is used instead). | LOW | `apps/api/src/knowledge/knowledge.controller.ts:124-130` |
| `workspaces/:ws/knowledge-sources/backfill` | POST | Workspace-wide re-embed; admin/ops. | LOW | `apps/api/src/knowledge/knowledge.controller.ts:216-235` |
| `workspaces/:ws/crm-credentials/:id` | PATCH | Edit a CRM credential (UI: delete + recreate). | LOW | `apps/api/src/workspace-crm/workspace-crm.controller.ts:44-54`; `apps/web/app/dashboard/settings/crm/page.tsx` has create/test/delete only (72, 92, 100) |
| `workspaces/:ws/campaigns/:id`, `…/:id/stats` | GET | Campaign detail/stats. Redundant: list DTO already embeds `stats`. | LOW | `apps/api/src/outbound-campaign/outbound-campaign.controller.ts:25-39`; `apps/web/app/dashboard/campaigns/page.tsx:19,304-307` |
| `workspaces/:ws/phone-numbers/:id/assign`, `…/:id` | PATCH / DELETE | Legacy number assign/release; telephony equivalents are wired. Only the legacy GET is used (as a "has any number" check). | LOW | `apps/api/src/phone-numbers/phone-numbers.controller.ts:53-75`; `apps/web/app/dashboard/campaigns/page.tsx:95-104` |
| `workspaces/:ws/telephony/providers` | GET | Provider catalogue; UI hardcodes `'twilio' \| 'vobiz' \| 'sip'`. | LOW | `apps/api/src/telephony/telephony.controller.ts:33-36`; `apps/web/app/dashboard/settings/phone-numbers/page.tsx:28` |
| `workspaces/:ws/analytics/events` | POST / GET | Raw analytics event ingest + list; dashboard uses the 4 aggregate endpoints. | LOW | `apps/api/src/analytics/analytics.controller.ts:75-92` |
| `workspaces/:ws/compliance/check` | POST | Pre-dial compliance check. Used internally by calls and telephony services, so no UI needed. | LOW | `apps/api/src/compliance/compliance.controller.ts:30-44`; internal callers `apps/api/src/calls/calls.service.ts:439`, `apps/api/src/telephony/telephony.service.ts:785` |
| `agents/generate` (POST, GET `:id`, POST `:id/publish`) | 3 routes | Old orchestrator generation flow. Its only web callers are two components that are **not mounted anywhere** (§2). Superseded by `workspaces/:ws/agents/generate` and `agent-gen-sessions`. | LOW | `apps/api/src/orchestrator/orchestrator.controller.ts:25-52`; callers `apps/web/components/agent-builder-form.tsx:47-48`, `apps/web/components/agent-preview-panel.tsx:45-46`; grep `AgentBuilderForm\|AgentPreviewPanel` outside those files = 0 |
| `workspaces/:ws/calendar/status`, `connect`, `disconnect` | GET / POST / DELETE | Legacy Google Calendar connection; superseded by `google-connection` (which the Google settings page uses, including calendar scopes). | LOW | `apps/api/src/calendar/calendar.controller.ts:9-38`; `apps/web/app/dashboard/settings/google/page.tsx:19-20,56,79,93` |
| `workspaces/:ws/google/callback` | GET | GET form of the OAuth callback; web forwards via POST instead. | LOW | `apps/api/src/google-connection/google-connection.controller.ts:47-62`; `apps/web/app/integrations/google/callback/route.ts` → `googleConnectionApi.callback` (`apps/web/lib/api.ts:151`, POST) |
| `workspaces`, `workspaces/:ws` | GET | List/get workspaces (session `/auth/me` carries them). | LOW | `apps/api/src/workspaces/workspaces.controller.ts:19-29` |
| `orgs/:orgId/audit-logs` | GET | Org-wide audit export; workspace-level audit log is wired. Not in proxy allowlist. | LOW | `apps/api/src/audit/audit-export.controller.ts:47-48`; `apps/web/lib/proxy-guards.ts:29-31` (comment confirms deliberate) |

### Not meant for the UI (listed for completeness)

`@InternalOnly()`: `admin/audit/export` GET, `admin/audit/report` POST (`audit-export.controller.ts:76-103`); `admin/billing/orgs/:orgId/clear-balance-review` POST (`billing-admin.controller.ts:33-38`); `internal/runtime/usage/events` POST (`runtime-usage.controller.ts:19-24`); `admin/compliance/manifest` GET (`compliance-manifest.controller.ts:11-16`); `admin/orgs/:orgId` DELETE (`erasure.controller.ts:70-72`); `admin/retention/sweep` POST (`retention.controller.ts:13-18`); `internal/livekit/agents/:id/tools/invoke` POST (`livekit-tools.controller.ts:39-47`); `internal/livekit/agents/:id/knowledge/search` POST (`livekit-knowledge.controller.ts:31-39`).

Webhooks / public infra: `voice/webhooks/:provider` (`voice-webhook.controller.ts:10-17`), `metrics` (`metrics.controller.ts:12-17`), `health` (`health.controller.ts:11-20`), 7 telephony webhooks incl. `livekit/webhooks` (`telephony-webhook.controller.ts:12-97`), `voice/webhook/inbound|status` (`twilio-webhook.controller.ts:18-170`), `webhooks/dodo` (`dodo-webhook.controller.ts:13-18`). Also public: `agents/a/:id` — this one **is** wired (`apps/web/app/a/[slug]/page.tsx:62`).

## 2. UI without backend / dead ends

No web call targets a path that no controller serves. All dead ends are navigation or rendering:

1. **Broken link → 404.** `apps/web/app/dashboard/settings/crm/page.tsx:296` renders `<a href="/dashboard/settings/crm/rules">Open Routing Rules</a>`; there is no `apps/web/app/dashboard/settings/crm/rules/` directory. The whole "rules" tab (`:294-298`) is just this link.
2. **Orphan page: CRM settings.** `apps/web/app/dashboard/settings/crm/page.tsx` exists but nothing links to it — not the sidebar (`apps/web/components/layout/app-sidebar.tsx:42-68`), not the Settings panel, not Integrations. grep `settings/crm` across `apps/web/{app,components,lib}` excluding the page itself = 0. Customers cannot reach CRM credential setup, even though its API is fully wired.
3. **Orphan page: Retention settings.** Same for `apps/web/app/dashboard/settings/retention/page.tsx` (PATCH `/workspaces/me/retention` is wired at `:20-21`); grep `settings/retention` = 0 inbound links.
4. **Dead components.** `apps/web/components/agent-builder-form.tsx` and `apps/web/components/agent-preview-panel.tsx` are imported nowhere. They are the only callers of `/agents/generate` (orchestrator), which is what keeps that prefix "alive" in `apps/web/lib/proxy-guards.ts:48` — the allowlist test (`proxy-guards.test.ts:169` scans `components/`) counts them as callers.
5. **Hardcoded checklist state.** `apps/web/app/dashboard/page.tsx:301` — `{ text: 'Add knowledge or FAQs', done: false, … }`. `loadDashboard` fetches only agents and calls (`:55-56`), so this step can never show as done.
6. **"Paused" filter with no pause action.** `apps/web/components/agents/agents-list-client.tsx:20` offers a Paused filter and `apps/web/app/dashboard/agents/page.tsx:78` a Paused stat, but no component calls `POST …/pause` (backend exists, see §1).
7. **Swallowed load errors.** `apps/web/app/dashboard/campaigns/page.tsx:86,107` and `apps/web/components/settings-panel.tsx:84,92` end with `.catch(console.error)`; a failed load renders an empty list with no message (campaigns has `handleCampaignError` for mutations only, `:181`).
8. **Misleading empty state on finished calls.** `apps/web/components/call-live-monitor.tsx:170-172` shows "Connecting to call..." when `turns` is empty and the SSE isn't connected — including for `status === 'completed'` calls whose provider transcript fetch failed (`apps/api/src/calls/calls.service.ts:690-697` swallows that error and returns `[]`). The `transcript_text` fallback is never used (§3).

Marketing-only: `apps/web/components/demo-audio-player.tsx:70` shows "Demo audio coming soon" when no `src` (used on `/` and `/a/[slug]`). Not a dashboard defect.

## 3. Returned but never rendered

| Field | Where returned | Why it matters | Sev | Evidence |
|---|---|---|---|---|
| `CallDetail.recording_url` | `GET workspaces/:ws/calls/:id` | Call recordings are stored (populated from the runtime `call.ended` payload) but there is no player or link anywhere. | HIGH | schema `packages/shared/src/schemas/call.ts:107`; populated `apps/api/src/calls/calls.service.ts:705` from `:877-904`; grep `recording_url` in `apps/web/{app,components}` = 0 |
| `CallDetail.transcript_text` | same | Stored full-text transcript. Detail page renders only `turns`; when turns are empty the text is never shown. | MEDIUM | `packages/shared/src/schemas/call.ts:106`; grep `transcript_text` in web = 0 |
| `CallSummary.pipeline` (`realtime` vs `standard`) | list + detail | Pipelines bill at different per-minute rates (`packages/shared/src/billing/catalog.ts:15`), yet neither the calls list nor detail shows which one ran. | LOW | `packages/shared/src/schemas/call.ts:71`; `apps/web/app/dashboard/calls/page.tsx:124-140`, `apps/web/app/dashboard/calls/[callId]/page.tsx` (no `pipeline`) |
| `CallEvaluationMetric.reason` | detail `evaluation.metric_scores[]` | The per-metric explanation is dropped; only name + score render. | LOW | `packages/shared/src/schemas/call.ts:87`; `apps/web/app/dashboard/calls/[callId]/page.tsx:152-161` |

Checked and fine: billing `usage.limits/usage` are rendered (`apps/web/components/billing-panel.tsx:210-211,446-450`); campaign `stats` rendered (`campaigns/page.tsx:304-307`); knowledge `status`/`chunk_count` rendered (`knowledge-panel.tsx:181,185`).

## 4. Recommended fixes, cheapest first

Ranked by user-visible value per line of code.

1. **Fix the 404 link** — `apps/web/app/dashboard/settings/crm/page.tsx:296`: either point it at a real page or delete the "rules" tab. 1–3 lines.
2. **Add sidebar entries** for `/dashboard/settings/crm` and `/dashboard/settings/retention` in `apps/web/components/layout/app-sidebar.tsx:63-68`. 2 lines; unlocks two fully-wired features.
3. **Render the recording** — `<audio controls src={detail.recording_url} />` in the call detail metadata card when non-null. ~5 lines.
4. **Fall back to `transcript_text`** when `turns.length === 0`, and change the empty-state copy for `status === 'completed'` to "No transcript captured" (`call-live-monitor.tsx:170-172`). ~6 lines.
5. **Pause button** beside `PublishAgentButton` in the builder header — copy `apps/web/components/publish-agent-button.tsx` (20 lines) and change the path to `/pause`; show it only when `status === 'published'`.
6. **Reindex button** on failed knowledge sources in `knowledge-panel.tsx` — one mutation + one button. ~12 lines.
7. **Surface load errors** — replace the four `.catch(console.error)` with `toast.error(err.message)` (toast is already imported in sibling components). 4 lines.
8. **Delete dead code**: `agent-builder-form.tsx`, `agent-preview-panel.tsx`, the `/agents/generate` allowlist prefix (`proxy-guards.ts:48`), and — if nobody else needs it — the `orchestrator.controller.ts` routes and `calendar` module (superseded by `google-connection`). Net-negative diff; removes a proxy-exposed surface with no live caller.
9. **Fix the checklist** — fetch `knowledge-sources` count in `loadDashboard` or drop the step (`dashboard/page.tsx:301`). ~3 lines.
10. **"Call me" outbound test** — small form (phone number + number picker) posting `POST /telephony/outbound-calls`; DTO and route already exist. ~40 lines; this is the highest-value missing feature but not the cheapest.
11. **Agent rename/description edit** → `PATCH /agents/:id`. ~30 lines.
12. **Contact edit + erase** in the compliance panel → `PATCH /contacts/:id`, `DELETE /workspaces/me/contacts/:id/erasure`. ~40 lines; closes a GDPR promise gap.
13. **Workspace rename** in settings → `PATCH /workspaces/:id`. ~25 lines.
14. **Referrals**: decide. Either add a page + `/referrals` proxy prefix, or remove `ReferralModule` (`apps/api/src/app.module.ts:92`). Leaving a 4-route module with zero consumers is pure maintenance cost.
15. Show `pipeline` as a small badge in the calls list/detail; render `metric.reason` as a tooltip. ~6 lines, low value.

Unverified / out of scope: whether any of the orphan routes have non-web consumers (mobile, CLI, partner API) — no evidence of such consumers was found in the repo, but absence of evidence is not proof.
