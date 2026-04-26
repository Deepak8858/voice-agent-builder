# 12 — Analytics

## Goal
Track performance, failures, cost, compliance, and business outcomes.

## Event Model
```json
{
  "event_id": "uuid",
  "event_type": "appointment.booked",
  "workspace_id": "uuid",
  "agent_id": "uuid",
  "call_id": "uuid",
  "timestamp": "2026-04-24T12:00:00Z",
  "payload": {}
}
```

## Metrics
### Workspace
total calls, total minutes, total cost, answer rate, failed call rate, outcomes.

### Agent
success rate, booking rate, lead qualification rate, transfer rate, tool success rate, fallback rate, average duration, cost per successful outcome.

### Agency
clients, calls per client, usage per client, revenue/cost/margin estimate, active agents.

### Compliance
blocked calls, block reasons, opt-outs, missing consent, DNC hits.

## Call Outcomes
appointment_booked, lead_qualified, message_taken, human_transfer_completed, caller_hung_up, no_answer, voicemail, tool_failed, agent_failed, not_interested, opted_out, other.

## Post-Call Evaluation
After each call, evaluate goal completion, required fields, tool success, hallucination risk, compliance messages, and improvement suggestions.
