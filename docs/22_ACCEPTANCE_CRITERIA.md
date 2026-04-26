# 22 — Acceptance Criteria

## MVP Demo Must Pass
1. User signs up.
2. User creates agency workspace.
3. User creates client workspace.
4. User generates dental receptionist agent from prompt.
5. User views valid Agent Spec JSON.
6. User adds FAQ knowledge.
7. User starts test call.
8. Mock/real agent produces transcript.
9. User publishes agent.
10. Inbound webhook creates call record.
11. User sees call transcript, events, and outcome.
12. User runs outbound compliance check.
13. User configures white-label logo/color.
14. Client user sees only own workspace.

## Must Be True
No TypeScript errors; core tests pass; workspace isolation works; invalid agent spec cannot publish; tool calls are logged; compliance blocks missing-consent outbound call; calls show transcript/events; white-label branding applies to client dashboard; billing usage records call minutes.

## Must Not Happen
Cross-tenant data access, outbound call without compliance, secret exposed to frontend, provider webhooks processed twice, raw LLM output trusted without validation, unlogged external tool execution.
