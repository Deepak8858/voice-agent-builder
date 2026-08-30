# PostHog Integration Audit Report

**Audit date:** 2026-08-13  
**Repository:** `Deepak8858/voice-agent-builder`  
**Pull request:** [#49](https://github.com/Deepak8858/voice-agent-builder/pull/49)  
**Merge commit:** `c722d68affec11af59456e30be93b81ee9ee78e1`

## Verdict

The implementation is **not fully production-ready**.

The server-side privacy architecture is strong, automated checks pass, and PR #49 is merged. The remaining blockers are:

1. Production browser analytics is not configured or active.
2. A legacy global identity component sends user email to PostHog and conflicts with the new identity bridge.
3. Thirteen browser event names bypass the closed shared event contract.
4. Consent and retention governance are documented but not enforced.
5. Live PostHog project state could not be inspected because both configured PostHog MCP endpoints failed during tool discovery.

## Deferred remediation checklist

### Priority 1 — Identity and privacy

- [ ] Remove all PostHog identity handling from `apps/web/components/layout/client-chrome.tsx`.
- [ ] Ensure `apps/web/components/analytics/posthog-identity-bridge.tsx` is the only authenticated browser identity path.
- [ ] Never send email, name, phone number, or other direct identifiers as PostHog person properties.
- [ ] Add a regression test proving `posthog.identify()` receives only the opaque application user ID.
- [ ] Verify account switching resets the previous identity before identifying the next user.
- [ ] Verify logout and server-detected authentication loss clear identity and workspace groups.

### Priority 2 — Enforce the event contract

- [ ] Add an ESLint `no-restricted-imports` rule preventing direct `posthog-js` imports outside approved analytics modules.
- [ ] Migrate or remove every direct event listed below.
- [ ] Add each retained event to `packages/shared/src/analytics/posthog-events.ts` with a bounded Zod property schema.
- [ ] Route browser events through `captureFunnelEvent()`.
- [ ] Add tests proving unknown event names and properties are dropped.
- [ ] Explicitly document whether `$pageview` and `$pageleave` are approved PostHog system events.

Direct off-contract events found:

- `onboarding_completed` — `apps/web/app/onboarding/page.tsx:56`
- `checkout_started` — `apps/web/components/billing-panel.tsx:110`
- `billing_portal_opened` — `apps/web/components/billing-panel.tsx:127`
- `agent_version_saved` — `apps/web/components/agent-spec-version-editor.tsx:62`
- `agent_generation_started` — `apps/web/components/agent-builder-form.tsx:63`
- `client_workspace_created` — `apps/web/components/clients-panel.tsx:62`
- `client_invite_sent` — `apps/web/components/clients-panel.tsx:82`
- `client_invite_revoked` — `apps/web/components/clients-panel.tsx:97`
- `white_label_settings_saved` — `apps/web/components/white-label-panel.tsx:79`
- `agent_flow_saved` — `apps/web/components/flow-builder/flow-builder-client.tsx:37`
- `knowledge_source_added` — `apps/web/components/knowledge-panel.tsx:85`
- `knowledge_source_removed` — `apps/web/components/knowledge-panel.tsx:105`
- `test_call_started` — `apps/web/components/test-call-drawer.tsx:42`

### Priority 3 — Governance

- [ ] Decide whether analytics requires opt-in consent for supported regions.
- [ ] Complete the PostHog DPA and data-residency review.
- [ ] Configure and document event/person retention periods.
- [ ] If opt-in is required, initialize PostHog opted out and enable capture only after consent.
- [ ] Test consent persistence together with login, logout, account switching, and identity resets.
- [ ] Document the approved event inventory and property dictionary.

### Priority 4 — Inspect and clean the PostHog project

- [ ] Search person properties for `email`, `name`, phone numbers, and other PII.
- [ ] Check whether Supabase auth IDs and application user IDs created duplicate person profiles.
- [ ] Merge or delete incorrectly split profiles where appropriate.
- [ ] Inspect all custom event names and remove obsolete/off-contract events.
- [ ] Confirm call events use `$process_person_profile: false`.
- [ ] Confirm call distinct IDs use `call:<opaque UUID>`.
- [ ] Confirm `$groups.workspace` and `$groups.organization` are populated correctly.
- [ ] Confirm no events contain transcripts, recordings, prompts, knowledge content, contact names, request bodies, or metadata blobs.
- [ ] Confirm the project region matches the configured ingestion host.
- [ ] Review project access controls, retention, dashboards, insights, feature flags, and ingestion errors.

### Priority 5 — Enable production only after remediation

- [ ] Add `NEXT_PUBLIC_POSTHOG_ENABLED=true` as a production repository variable.
- [ ] Add `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` using the production project token, not a personal API key.
- [ ] Add `NEXT_PUBLIC_POSTHOG_HOST` matching the project residency region.
- [ ] Configure runtime `POSTHOG_ENABLED`, `POSTHOG_PROJECT_TOKEN`, and `POSTHOG_HOST` for the API host.
- [ ] Rebuild and deploy the web image because `NEXT_PUBLIC_*` values are build-time inputs.
- [ ] Verify `/vf-relay/e/`, `/vf-relay/flags`, `/vf-relay/static/*`, and `/vf-relay/array/*` do not redirect or pass through authentication middleware.
- [ ] Confirm browser and server events appear in PostHog Live Events.
- [ ] Confirm release and environment properties contain the expected deployment values.
- [ ] Build dashboards only after identity, grouping, and event correctness are verified.

## Findings

### High — Conflicting identity path sends email

`apps/web/components/layout/client-chrome.tsx:32` calls `posthog.identify(user.id, { email: user.email })`. The component is mounted globally by `apps/web/app/layout.tsx:38`.

The new identity bridge separately identifies users using server-resolved application IDs and intentionally sends no person properties. The two implementations can overwrite or reset one another, fragment profiles, misattribute workspace events, and violate the stated ID-only privacy policy.

### High — Production browser analytics is inactive

The production GitHub repository variables did not contain:

- `NEXT_PUBLIC_POSTHOG_ENABLED`
- `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`
- `NEXT_PUBLIC_POSTHOG_HOST`

The deployment workflow reads these values from repository variables, so the deployed browser SDK remains uninitialized. Inspection of the public production JavaScript bundles found no PostHog project token, relay configuration, or initialization code.

### High — Browser events bypass the shared privacy boundary

The direct SDK events listed in the checklist are absent from `POSTHOG_EVENT_NAMES`. They therefore bypass event-name allowlisting, Zod property schemas, forbidden-property checks, identity-kind enforcement, tenant-context construction, and centralized tests.

### Medium — Consent policy is operational, not enforced

Autocapture, replay, exceptions, performance capture, heatmaps, and DOM-content capture are disabled. However, enabling the environment flag starts pageview capture without an implemented consent state or controlled opt-in flow.

### Medium — Live PostHog state remains unverified

Both configured PostHog MCP endpoints failed before exposing tools. Project settings, events, people, groups, dashboards, retention, flags, and ingestion errors therefore require manual verification or a repaired MCP connection.

### Low — Automatic system events are outside the declared vocabulary

The SDK configuration enables `$pageview` and `$pageleave`, while the shared contract describes a closed event vocabulary. Either document these as approved SDK events or disable them and use a schema-controlled navigation event.

## Positive controls confirmed

- Closed server/custom event schema with Zod.
- Unknown properties are stripped.
- Forbidden keys and phone-like values receive defense-in-depth checks.
- Call lifecycle events use non-person identities.
- `$process_person_profile: false` is applied to autonomous call events.
- Workspace and organization groups are resolved server-side.
- Public/user-controlled analytics ingestion is not mirrored to PostHog.
- Postgres remains the source of truth.
- PostHog failures cannot break primary product flows.
- Transcripts, recordings, phone numbers, names, prompts, and metadata are excluded by the shared contract.
- Session replay, autocapture, exception capture, heatmaps, and performance capture are disabled.
- Browser traffic uses a same-origin proxy.
- CSP is not widened to PostHog origins.
- API shutdown includes a bounded PostHog flush.
- Tests cover hostile payloads, PII stripping, identity switching, malformed tenant IDs, proxy routing, and shutdown behavior.

## Verification record

- PR #49 merged successfully.
- Final GitHub checks all passed.
- Local lint passed with 14 warnings and no errors.
- Typecheck passed.
- 533 tests passed.
- Production build passed.
- No tracked files were modified during the audit.
- Existing unrelated untracked file: `framer.md`.

## Completion criteria

The integration can be considered complete when all of the following are true:

- [ ] Only one ID-only browser identity path exists.
- [ ] No UI component imports `posthog-js` directly.
- [ ] Every custom event and property is represented in the shared contract.
- [ ] Consent, retention, residency, and access policies are approved and enforced.
- [ ] Existing PostHog data has been checked for email leakage and split identities.
- [ ] Production browser and API configuration is present.
- [ ] Relay routes and Live Events are verified.
- [ ] Person, group, and non-person call identity behavior is correct in the live project.
- [ ] Required dashboards and alerts use validated events.
