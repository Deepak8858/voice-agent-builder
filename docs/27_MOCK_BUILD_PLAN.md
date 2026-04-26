# 27 — Mock Build Plan

## Purpose
Build a realistic MVP without waiting for all provider credentials.

## Mock Services
### Mock LLM
Input: user prompt and template. Output: valid Agent Spec JSON.

### Mock Voice Provider
Supports createAgent, createBrowserTestSession, startOutboundCall, fake transcript, fake call events, fake recording URL.

### Mock Calendar
Supports check availability, book slot, fail booking scenario.

### Mock Billing
Supports plan display, fake usage, usage records.

## Mock Test Call
When user starts test call:
1. Create call record.
2. Generate scripted transcript.
3. Generate events.
4. Generate outcome.
5. Show analytics.

## Why Mock First
Speeds frontend/backend build, preserves architecture, allows investor/user demo, makes real provider integration cleaner later.
