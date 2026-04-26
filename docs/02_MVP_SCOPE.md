# 02 — MVP Scope

## MVP Goal
Build a sellable beta that supports inbound AI receptionists, opt-in follow-up calls, basic analytics, compliance checks, and white-label agency workspaces.

## Must Have
### SaaS
Auth, organizations, workspaces, agency/client hierarchy, roles.

### Agent Builder
Prompt-to-agent generation, template selection, Agent Spec JSON validation, drafts, versions, publish/pause status.

### Templates
AI receptionist, dental receptionist, real estate lead qualifier, appointment reminder, D2C order confirmation.

### Knowledge
Manual FAQ, PDF upload, CSV upload, embeddings with pgvector, agent-scoped retrieval.

### Voice
Mock provider first, Vapi/Retell adapter after mock, browser test session, inbound call support, transcript and call events.

### Compliance
Consent records, DNC/DND entries, opt-out, call window, AI disclosure, recording notice, audit logs.

### Analytics
Call count, minutes, outcomes, bookings, transfers, tool success/failure, cost estimate.

### White Label
Agency workspace, client workspace, logo/color branding, client dashboard, usage by client.

## MVP Demo Flow
```txt
Agency creates client workspace → chooses dental template → generates agent → adds FAQs → connects/mock calendar → test call → publishes mock/real inbound agent → views call transcript and analytics → brands client dashboard
```
