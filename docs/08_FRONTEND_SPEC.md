# 08 — Frontend Specification

## Goal
Build a premium SaaS frontend that feels like Lovable for voice agents.

## Main Screens
```txt
/public landing
/login
/signup
/dashboard
/dashboard/agents
/dashboard/agents/new
/dashboard/agents/[agentId]/builder
/dashboard/agents/[agentId]/flow
/dashboard/agents/[agentId]/knowledge
/dashboard/agents/[agentId]/test
/dashboard/agents/[agentId]/deploy
/dashboard/agents/[agentId]/analytics
/dashboard/calls
/dashboard/calls/[callId]
/dashboard/templates
/dashboard/integrations
/dashboard/clients
/dashboard/white-label
/dashboard/billing
/dashboard/settings
```

## Key Components
```txt
AppSidebar, Topbar, WorkspaceSwitcher, AgentCard, AgentSetupChecklist, BuilderChat, AgentGeneratedPreview, FlowCanvas, NodeSettingsPanel, TestCallPanel, LiveTranscript, CallsTable, CallTimeline, RecordingPlayer, MetricCard, ComplianceChecklist, WhiteLabelPreview
```

## Builder UX
```txt
Describe need → Generate agent → Show preview → Edit with chat → Open visual flow → Add knowledge → Test → Publish
```

## Flow Builder Node Types
Start, Speak, Ask Question, Condition, Knowledge Lookup, Tool Call, Transfer, SMS/Email, End, Fallback.

## Test Playground
Must show start/end test call, live transcript, event timeline, tool calls, latency indicator, evaluation result, and suggested fixes.

## UI Quality Bar
The platform must look like a serious modern SaaS, not a hackathon demo. Use calm layouts, setup checklists, strong empty states, loading states, and clear warnings.
