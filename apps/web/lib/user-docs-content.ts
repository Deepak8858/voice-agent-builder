export interface DocsStep {
  title: string;
  href: string;
  summary: string;
  details: string[];
  result: string;
}

export interface DashboardDocItem {
  title: string;
  href: string;
  purpose: string;
  primaryActions: string[];
  notes: string[];
}

export interface DashboardDocGroup {
  title: string;
  description: string;
  items: DashboardDocItem[];
}

export interface UserDocsConcept {
  title: string;
  body: string;
  bullets: string[];
}

export interface AgentSpecReference {
  key: string;
  label: string;
  purpose: string;
  userImpact: string;
  validation: string;
}

export interface ChecklistSection {
  title: string;
  description: string;
  items: string[];
}

export interface TroubleshootingItem {
  problem: string;
  fix: string;
}

export const firstWorkingDemoSteps: DocsStep[] = [
  {
    title: '1. Sign up',
    href: '/sign-up',
    summary: 'Create your account and enter the authenticated dashboard.',
    details: [
      'Use the sign-up screen to create a user session.',
      'After authentication, VoiceForge provisions or loads your active workspace.',
      'The dashboard only renders after the app confirms your session with the API.',
    ],
    result: 'You land in a workspace-scoped dashboard with navigation for building, operating, and managing agents.',
  },
  {
    title: '2. Create or choose a workspace',
    href: '/dashboard/settings',
    summary: 'Work inside the active workspace shown at the top of the dashboard.',
    details: [
      'All agents, calls, contacts, tools, compliance records, billing usage, and white-label settings belong to a workspace.',
      'Agency users can create client workspaces from Clients, then invite client users into those workspaces.',
      'Use Settings to inspect account, team, and audit information for the current workspace.',
    ],
    result: 'Every record you create is scoped to the current workspace.',
  },
  {
    title: '3. Generate an agent from a prompt',
    href: '/dashboard/agents/new',
    summary: 'Describe the phone workflow, business context, and expected outcome.',
    details: [
      'Use Create Agent to write natural-language instructions like you would give a human phone agent.',
      'Pick a template or let VoiceForge auto-match one from the prompt.',
      'Add business name, timezone, and optional workspace knowledge sources before generating.',
      'The generator creates provider-neutral Agent Spec JSON, not a raw prompt-only agent.',
    ],
    result: 'You get a draft agent that can be reviewed, edited, and saved.',
  },
  {
    title: '4. View Agent Spec JSON',
    href: '/dashboard/agents',
    summary: 'Open the agent builder and inspect the validated spec behind the agent.',
    details: [
      'The builder shows form controls for common fields and JSON mode for the complete contract.',
      'Validation badges show whether the current spec can be saved as a new version.',
      'Every saved edit creates a new version before the agent is published.',
    ],
    result: 'You can explain exactly what the agent is allowed to say, collect, retrieve, call, and escalate.',
  },
  {
    title: '5. Test call',
    href: '/dashboard/agents',
    summary: 'Run a browser test call before any real caller reaches the agent.',
    details: [
      'Open the agent builder and select Test call.',
      'VoiceForge creates a browser test session and call record for review.',
      'The drawer shows transcript turns as they become available, then links to the full call record.',
    ],
    result: 'You have a safe mock/browser call path for checking conversation behavior before publishing.',
  },
  {
    title: '6. Publish',
    href: '/dashboard/agents',
    summary: 'Deploy the latest saved agent version only after review.',
    details: [
      'The Publish action promotes the current version for live traffic.',
      'Use the launch checklist in the builder to confirm spec, flow, compliance, and handoff basics.',
      'Published agents are shown as active in the agent list and dashboard metrics.',
    ],
    result: 'The agent is ready for connected phone numbers or outbound workflows that pass compliance checks.',
  },
  {
    title: '7. View transcript',
    href: '/dashboard/calls',
    summary: 'Review call history, status, transcript turns, metadata, and evaluation results.',
    details: [
      'The Calls page lists browser tests, inbound calls, and outbound calls for the workspace.',
      'Open a call to inspect contact details, timing, provider, transcript, and post-call evaluation when present.',
      'Live Transcript keeps the stored transcript visible and can follow a call as it updates.',
    ],
    result: 'You can audit what happened on the call and decide whether the agent needs improvement.',
  },
  {
    title: '8. See analytics',
    href: '/dashboard/analytics',
    summary: 'Track call volume, success rates, agent performance, outcomes, and compliance blocks.',
    details: [
      'Switch between 7-day, 30-day, and 90-day windows.',
      'Review workspace KPIs, call volume charts, outcome distribution, and per-agent performance.',
      'Use the compliance summary to see opt-outs, Do-Not-Call hits, missing consent, and block reasons.',
    ],
    result: 'You can see where the agent is working and where operating rules block calls.',
  },
  {
    title: '9. Configure white-label branding',
    href: '/dashboard/white-label',
    summary: 'Set the client-facing brand for agency and white-label work.',
    details: [
      'Configure brand name, logo URL, primary color, support email, custom domain, and whether to hide VoiceForge branding.',
      'Use Clients to create client workspaces and invite client admins or viewers.',
      'Custom domain DNS and TLS provisioning are handled outside the dashboard for now.',
    ],
    result: 'Agencies can present the platform under their own brand and manage client workspaces.',
  },
];

export const userDocsConcepts: UserDocsConcept[] = [
  {
    title: 'Workspaces are the tenant boundary',
    body: 'VoiceForge is multi-tenant. Workspace membership controls what a user can see, and every customer record is scoped to a workspace or organization.',
    bullets: [
      'Agents, versions, knowledge, tools, contacts, DNC entries, calls, analytics, billing, audit logs, phone numbers, and white-label settings are workspace records.',
      'Agency workflows use a parent workspace for agency operations and client workspaces for client accounts.',
      'If something is missing from a list, first confirm you are in the intended workspace.',
    ],
  },
  {
    title: 'Agent Spec JSON is the central contract',
    body: 'The app does not treat an agent as only a prompt. Agent Spec JSON is the validated contract shared by the builder, visual flow editor, runtime adapters, compliance checks, tools, analytics, and publishing.',
    bullets: [
      'The form editor changes the same JSON contract that JSON mode displays.',
      'Saving a valid spec creates a new agent version.',
      'Calls should be interpreted against the exact version that was active when the call ran.',
    ],
  },
  {
    title: 'Testing is separate from publishing',
    body: 'A draft agent can be generated, edited, and browser-tested without becoming live. Publishing is the action that promotes the latest version for real traffic.',
    bullets: [
      'Use browser test calls to validate the greeting, question order, knowledge lookup behavior, and handoff instructions.',
      'Use call transcripts to adjust the Agent Spec rather than patching one-off prompts.',
      'Republish after saving a new version that should receive live traffic.',
    ],
  },
  {
    title: 'No outbound call runs without compliance checks',
    body: 'No outbound call may start unless compliance checks pass for the workspace, agent, purpose, contact, consent, DNC status, call window, and disclosure rules.',
    bullets: [
      'Contacts can have consent records for outbound marketing, outbound transactional, recording, and AI disclosure.',
      'Opted-out contacts and Do-Not-Call entries block future outbound calls.',
      'Allowed outbound purposes include appointment reminders, missed-call callbacks, lead-form callbacks, order confirmations, event confirmations, and requested follow-ups.',
    ],
  },
  {
    title: 'Tools are validated and logged',
    body: 'Integrations are configured as permissioned tools with input schemas. Tool calls are validated before execution and recorded as invocations.',
    bullets: [
      'Use snake_case tool names so agents can reference tools consistently.',
      'Webhook tools can use HMAC signing and timeouts.',
      'Google Calendar and CRM tools store secret values server-side and show only safe public configuration in the dashboard.',
    ],
  },
  {
    title: 'Voice and telephony providers are adapters',
    body: 'Phone numbers and realtime voice runtime are connected through provider adapters rather than one hard-coded provider path.',
    bullets: [
      'Phone Numbers supports Twilio and Vobiz connections plus manual SIP setup.',
      'LiveKit routing is configured after a number is imported or manually added and assigned to an agent.',
      'Provider credentials are entered in provider-specific forms, while the Agent Spec remains provider-neutral.',
    ],
  },
];

export const dashboardDocumentation: DashboardDocGroup[] = [
  {
    title: 'Build',
    description: 'Create, inspect, and version the agents that will talk to customers.',
    items: [
      {
        title: 'Voice Agents',
        href: '/dashboard/agents',
        purpose: 'List every agent in the workspace, search by status, and open the builder.',
        primaryActions: [
          'Review active, draft, and paused agent counts.',
          'Open an agent to edit flow, spec, knowledge, tests, versions, and suggestions.',
          'Create a new agent when a new phone workflow needs its own lifecycle.',
        ],
        notes: [
          'Published means the agent can be used for live traffic.',
          'Draft means the agent exists but should be tested and published before real use.',
        ],
      },
      {
        title: 'Create Agent',
        href: '/dashboard/agents/new',
        purpose: 'Generate an Agent Spec from natural language, a template, business context, and optional knowledge sources.',
        primaryActions: [
          'Write a clear phone workflow prompt.',
          'Select a use-case template or let the system auto-match one.',
          'Generate, review validation, and save the draft.',
        ],
        notes: [
          'Strong prompts include goals, tone, facts the agent may use, required fields, handoff rules, and what to do when unsure.',
          'The save button is disabled until the generated Agent Spec validates.',
        ],
      },
      {
        title: 'Templates',
        href: '/dashboard/templates',
        purpose: 'Start from vertical agent templates instead of a blank workflow.',
        primaryActions: [
          'Browse prebuilt use cases such as AI receptionist, dental receptionist, real estate qualifier, appointment reminder, and order confirmation.',
          'Use a template to prefill the create-agent flow.',
          'Customize the generated spec for your business before saving.',
        ],
        notes: [
          'Templates include goals, required fields, compliance defaults, handoff conditions, and analytics events.',
          'A template is a starting point, not a published agent.',
        ],
      },
    ],
  },
  {
    title: 'Operate',
    description: 'Run calls, connect systems, and monitor production behavior.',
    items: [
      {
        title: 'Calls',
        href: '/dashboard/calls',
        purpose: 'Review browser test, inbound, and outbound call records.',
        primaryActions: [
          'Filter mentally by status, provider, contact, direction, and created time from the list.',
          'Open a call to inspect transcript turns, metadata, provider information, duration, outcome, and evaluation.',
          'Use transcripts as evidence when tuning the agent.',
        ],
        notes: [
          'Browser test calls are stored alongside live calls so testing history is auditable.',
          'A call can have queued, ringing, in-progress, completed, failed, or cancelled status.',
        ],
      },
      {
        title: 'Phone Numbers',
        href: '/dashboard/settings/phone-numbers',
        purpose: 'Connect telephony inventory and route phone calls through LiveKit to an agent.',
        primaryActions: [
          'Connect Twilio or Vobiz provider credentials and sync available numbers.',
          'Import selected provider numbers or add a manual SIP number.',
          'Assign a number to an agent, enable inbound or outbound, and configure LiveKit routing.',
        ],
        notes: [
          'Phone numbers should be entered in E.164 format, such as +14155550100.',
          'Vobiz setup requires a webhook signing secret before callbacks are accepted.',
          'BYO telephony can be plan-gated; upgrade prompts route to Billing when needed.',
        ],
      },
      {
        title: 'Campaigns',
        href: '/dashboard/campaigns',
        purpose: 'Upload contacts and launch guarded outbound calling campaigns.',
        primaryActions: [
          'Upload a CSV with phone, name, and optional email columns, or paste one contact per line.',
          'Preview normalized contacts and fix validation errors.',
          'Choose an agent, set max calls per hour and max concurrent calls, confirm consent and DNC review, then launch.',
        ],
        notes: [
          'The UI requires consent and DNC confirmations before launch.',
          'The compliance engine still runs per call before dialing.',
          'Campaigns can be started, paused, and monitored by completed, failed, and in-progress counts.',
        ],
      },
      {
        title: 'Knowledge Base',
        href: '/dashboard/knowledge',
        purpose: 'Add source material the agents can retrieve during calls.',
        primaryActions: [
          'Add inline text, upload PDF, CSV, TXT, or Markdown files, or point to a URL.',
          'Attach workspace-level sources from the Knowledge page.',
          'Attach agent-level sources from the builder.',
          'Test retrieval by asking a question and reviewing matching chunks.',
        ],
        notes: [
          'Workspace knowledge can be shared across agents.',
          'Agent-scoped knowledge stays attached to one agent.',
          'Retrieval mode and max chunks are controlled by the Agent Spec.',
        ],
      },
      {
        title: 'Integrations',
        href: '/dashboard/integrations',
        purpose: 'Create tools agents can call during conversations.',
        primaryActions: [
          'Create webhook, HTTP GET, HTTP POST, Google Calendar, or CRM tools.',
          'Define the input schema that arguments must satisfy.',
          'Test an invocation from the tool detail page.',
          'Review recent invocations and HTTP response status.',
        ],
        notes: [
          'Tool names must be snake_case.',
          'Webhook tools may include extra headers, HMAC secrets, and request timeouts.',
          'Tool invocations are logged with status, duration, error message, and response metadata.',
        ],
      },
      {
        title: 'Analytics',
        href: '/dashboard/analytics',
        purpose: 'Measure call volume, outcomes, agent performance, and compliance blocks.',
        primaryActions: [
          'Switch between 7-day, 30-day, and 90-day views.',
          'Review workspace KPIs for calls, minutes, success rate, answer rate, failed rate, and blocked calls.',
          'Compare per-agent calls, success rate, booking rate, tool success rate, duration, and evaluation score.',
        ],
        notes: [
          'Outcome charts help identify whether the agent is completing intended workflows.',
          'Compliance charts show opt-outs, DNC hits, missing consent, and top block reasons.',
        ],
      },
    ],
  },
  {
    title: 'Manage',
    description: 'Control agency workspaces, governance, branding, subscription, and account settings.',
    items: [
      {
        title: 'Clients',
        href: '/dashboard/clients',
        purpose: 'Create and manage client workspaces under an agency workspace.',
        primaryActions: [
          'Create a client workspace with a name and slug.',
          'Select a client to view last-30-day calls, minutes, blocked calls, and active agents.',
          'Invite client users as admins or viewers and revoke pending invites.',
        ],
        notes: [
          'Invites are bound to the selected client workspace.',
          'Client usage lets agencies monitor account activity without mixing records across tenants.',
        ],
      },
      {
        title: 'Compliance',
        href: '/dashboard/compliance',
        purpose: 'Manage contacts, consent records, opt-outs, and the Do-Not-Call list.',
        primaryActions: [
          'Create or update contacts with phone, full name, and email.',
          'Grant or revoke consent types for a selected contact.',
          'Opt a contact out manually.',
          'Add or remove Do-Not-Call entries with reasons.',
        ],
        notes: [
          'Consent types include outbound marketing, outbound transactional, recording, and AI disclosure.',
          'DNC and opt-out records block future outbound calls.',
          'This page is operational governance, not legal advice.',
        ],
      },
      {
        title: 'White label',
        href: '/dashboard/white-label',
        purpose: 'Configure agency branding for client-facing surfaces.',
        primaryActions: [
          'Set brand name, logo URL, primary color, support email, and custom domain.',
          'Toggle whether to hide VoiceForge branding from client-facing pages.',
          'Preview the current brand values before saving.',
        ],
        notes: [
          'Custom domain DNS and TLS provisioning are outside the dashboard in the current app.',
          'Use Clients with white-label branding for agency-managed accounts.',
        ],
      },
      {
        title: 'Billing',
        href: '/dashboard/billing',
        purpose: 'Review subscription status, plan limits, usage meters, invoices, and Stripe actions.',
        primaryActions: [
          'Inspect the current plan and subscription status.',
          'Review usage for calls, minutes, tools, and agents.',
          'Upgrade through Stripe checkout when live billing is enabled.',
          'Open the customer portal for paid plans.',
        ],
        notes: [
          'Demo billing mode disables live checkout and portal actions while retaining trial limits.',
          'Checkout success and cancel banners appear after returning from Stripe.',
          'Invoices show when live billing data is available.',
        ],
      },
      {
        title: 'Settings',
        href: '/dashboard/settings',
        purpose: 'Inspect account information, team members, and audit logs.',
        primaryActions: [
          'Use General for user and workspace account context.',
          'Use Team to list workspace members and roles.',
          'Use Audit to review critical workspace actions.',
          'Use Data Retention to configure retention days between 30 and 3650.',
        ],
        notes: [
          'Audit logs are important for critical actions such as publishing, invites, compliance changes, and billing events.',
          'Retention policy should balance analytics needs, compliance requirements, and storage minimization.',
        ],
      },
    ],
  },
];

export const agentSpecReference: AgentSpecReference[] = [
  {
    key: 'identity',
    label: 'Identity',
    purpose: 'Business name, agent display name, and optional disclosure line.',
    userImpact: 'Controls how the agent introduces itself and who it says it represents.',
    validation: 'Business name and agent name are required.',
  },
  {
    key: 'voice',
    label: 'Voice',
    purpose: 'Tone, optional provider voice ID, interruptions, speaking rate, and optional language-specific voice configs.',
    userImpact: 'Shapes how the agent sounds while staying provider-neutral.',
    validation: 'Tone is required. Speaking rate must be between 0.5 and 2.0 when set.',
  },
  {
    key: 'goals',
    label: 'Goals',
    purpose: 'The outcomes the agent should drive toward.',
    userImpact: 'Keeps conversations focused on actions such as booking, qualifying, confirming, or escalating.',
    validation: 'At least one goal is required.',
  },
  {
    key: 'required_fields',
    label: 'Required fields',
    purpose: 'Structured data the agent should collect, such as name, phone, appointment time, budget, or order ID.',
    userImpact: 'Creates a clear checklist of information the agent should capture during calls.',
    validation: 'Each field needs a key and supported type. Enum fields can include allowed values.',
  },
  {
    key: 'conversation_rules',
    label: 'Conversation rules',
    purpose: 'Phone behavior guardrails such as one question at a time, confirming critical information, and not making up answers.',
    userImpact: 'Improves call quality and reduces risky improvisation.',
    validation: 'Defaults are safe, but review the first message and fallback behavior before testing.',
  },
  {
    key: 'knowledge',
    label: 'Knowledge',
    purpose: 'Retrieval mode, maximum chunks, fallback message, and selected source IDs.',
    userImpact: 'Determines whether the agent can answer from agent-scoped or workspace-scoped knowledge.',
    validation: 'Max chunks must be 0 through 20. Source IDs must reference existing knowledge sources.',
  },
  {
    key: 'tools',
    label: 'Tools',
    purpose: 'Tool names, descriptions, confirmation rules, input schemas, and optional permissions.',
    userImpact: 'Lets agents book appointments, update CRMs, send follow-ups, or call signed webhooks.',
    validation: 'Each tool needs a description and an object input schema. Tool calls are validated before execution.',
  },
  {
    key: 'handoff',
    label: 'Handoff',
    purpose: 'Human transfer behavior, target phone, and escalation conditions.',
    userImpact: 'Defines when the agent should stop automation and route to a person.',
    validation: 'If handoff is enabled, at least one condition must be defined.',
  },
  {
    key: 'compliance',
    label: 'Compliance',
    purpose: 'AI disclosure, recording notice, opt-out, outbound consent, and optional allowed call window.',
    userImpact: 'Controls whether calls are allowed and what disclosures the agent must follow.',
    validation: 'Outbound agents must require consent. Allowed call windows need timezone, start hour, and end hour.',
  },
  {
    key: 'analytics',
    label: 'Analytics',
    purpose: 'Success events that should count as positive outcomes.',
    userImpact: 'Makes dashboards reflect the events that matter to the business.',
    validation: 'Use stable event names such as appointment_booked, lead_qualified, or order_confirmed.',
  },
  {
    key: 'flow',
    label: 'Flow',
    purpose: 'Optional visual conversation flow made from start, speak, ask_question, condition, knowledge_lookup, tool_call, transfer, send_message, end, and fallback nodes.',
    userImpact: 'Gives users a visual map of the live phone conversation.',
    validation: 'Flow needs a valid start node, every branch target must reference an existing node, and at least one end node must exist.',
  },
];

export const checklistSections: ChecklistSection[] = [
  {
    title: 'Before publishing an agent',
    description: 'Use this checklist after generating or editing an agent and before pressing Publish.',
    items: [
      'The Agent Spec validation badge says Valid Agent Spec.',
      'The first message clearly identifies the business and, when required, that the caller is speaking with an AI assistant.',
      'Goals match the real call outcome you want.',
      'Required fields are realistic for a phone call and do not ask for unnecessary sensitive data.',
      'Knowledge sources are attached and retrieval search returns useful answers.',
      'Tool schemas match the data the external endpoint or calendar needs.',
      'Handoff conditions cover emergencies, uncertainty, and caller requests for a human.',
      'Compliance settings include outbound consent for outbound agents.',
      'A browser test call has been reviewed in Calls.',
    ],
  },
  {
    title: 'Before launching an outbound campaign',
    description: 'Outbound campaigns need both clean data and operating controls.',
    items: [
      'CSV or pasted contacts include valid phone numbers in a normalizable format.',
      'Contacts have the right consent for the campaign purpose.',
      'Contacts who opted out or appear on the DNC list are excluded.',
      'The selected agent is published and tested.',
      'Rate limits are conservative enough for staff to monitor early runs.',
      'The campaign purpose is allowed, such as appointment reminder, order confirmation, event confirmation, requested follow-up, lead-form callback, or missed-call callback.',
      'A human owner knows where to monitor Calls and Analytics after launch.',
    ],
  },
  {
    title: 'For agency and white-label accounts',
    description: 'Use this when onboarding a client workspace.',
    items: [
      'Create a client workspace with a stable slug.',
      'Configure white-label brand name, color, logo URL, and support email.',
      'Invite at least one client admin or viewer.',
      'Create or import the client agent in the client workspace, not the agency workspace unless intentionally shared.',
      'Confirm billing limits and plan gates before connecting phone numbers or campaigns.',
      'Check Audit after critical changes so the handoff to the client is traceable.',
    ],
  },
];

export const userDocsTroubleshooting: TroubleshootingItem[] = [
  {
    problem: 'The dashboard says the API is not reachable.',
    fix: 'Start the backend and confirm environment variables are configured. Dashboard pages call the API for session, workspace, agent, call, and billing data.',
  },
  {
    problem: 'The generated Agent Spec cannot be saved.',
    fix: 'Open the validation warnings in the form editor or JSON mode. Common fixes are adding handoff conditions, restoring outbound consent, adding at least one goal, or fixing flow node targets.',
  },
  {
    problem: 'A browser test call has no transcript yet.',
    fix: 'Open the call record from the test drawer and refresh after the test session creates turns. If no turns appear, verify the agent has a saved spec and the API can create test sessions.',
  },
  {
    problem: 'A phone number cannot be imported or configured.',
    fix: 'Check provider credentials, E.164 phone formatting, Vobiz webhook signing secret, selected provider numbers, agent assignment, and plan gates for BYO telephony.',
  },
  {
    problem: 'An outbound call or campaign is blocked.',
    fix: 'Review Compliance and Analytics block reasons. Add missing consent, remove DNC conflicts when appropriate, confirm the contact is not opted out, and use an allowed outbound purpose.',
  },
  {
    problem: 'A tool invocation fails.',
    fix: 'Open the tool detail page, test with valid JSON arguments, compare the arguments to the input schema, confirm the endpoint URL and method, and check whether HMAC or credentials are required.',
  },
  {
    problem: 'Billing actions are disabled.',
    fix: 'The workspace may be in demo billing mode. Usage limits still apply, but live Stripe checkout and portal actions require live billing configuration.',
  },
  {
    problem: 'A client cannot see expected agents or calls.',
    fix: 'Confirm the client is invited to the correct client workspace and that the records were created in that workspace. Workspace boundaries intentionally prevent cross-client visibility.',
  },
];
