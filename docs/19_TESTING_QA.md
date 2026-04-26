# 19 — Testing and QA

## Test Layers
Unit tests, integration tests, end-to-end tests, voice simulation tests, compliance tests, webhook tests, security tests.

## Required Unit Tests
Agent Spec validation, compliance rules, tool schema validation, workspace permissions, billing usage calculation, event mapping.

## E2E Flows
Create Agent: Signup → workspace → generate agent → save draft → publish.
Compliance: Contact without consent → outbound request → blocked → add consent → allowed.
White Label: Agency creates client → branding → client login → client sees only own data.

## Voice Simulation Scenarios
Normal booking, angry caller, asks for human, incomplete info, out-of-scope question, tool failure, caller interrupts.

## Non-Acceptable Failures
Cross-tenant data leak, outbound calls without compliance, unlogged tool calls, invalid spec published, missing call transcript/events.
