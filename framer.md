# Copy-paste prompt for Framer

## VoiceForge AI — Complete Product and Brand Redesign

Design a complete, production-ready visual system and responsive website/application prototype for **VoiceForge AI**, a multi-tenant SaaS platform for building, testing, deploying, monitoring, and white-labeling AI voice-calling agents.

This is a **full product redesign**, not a superficial reskin. Redesign:

- Brand expression
- Marketing website
- Hero imagery
- Navigation and footer
- Authentication and onboarding
- Application shell
- Dashboard
- Agent creation
- AI generation
- Visual agent builder
- Calls and transcripts
- Campaigns
- Analytics
- Compliance
- Knowledge management
- Integrations
- Client workspaces
- White-label controls
- Billing and pricing
- Settings
- Documentation
- Public agent demonstration pages
- Loading, empty, error, success, permission, and destructive states
- Desktop, tablet, and mobile behavior

Create one coherent design system that can later be implemented in the existing **Next.js 16, React 19, Tailwind CSS 4, TypeScript, Radix/shadcn-style component architecture**.

Do not simplify the product into a generic landing-page concept. Treat this as a serious, operational B2B SaaS product handling live calls, customer data, regulated workflows, credentials, transcripts, and business-critical automation.

## 1. Product context

VoiceForge AI is the fastest way for agencies, automation consultants, and business operators to create and sell reliable AI voice agents.

Users can:

1. Sign up and create an organization and workspace.
2. Choose a vertical template or describe an agent in natural language.
3. Generate a validated **Agent Spec JSON** contract.
4. Inspect and edit the generated agent.
5. Construct the conversation visually in a node-based flow builder.
6. Add business knowledge from text, URLs, PDFs, CSV files, or documents.
7. Connect webhook tools, calendars, CRM systems, and external workflows.
8. Run a browser-based test call.
9. Review the transcript, tool calls, latency, events, and evaluation.
10. Configure compliance and handoff policies.
11. Publish the agent.
12. Connect phone numbers and voice providers.
13. Run inbound calls or compliant outbound campaigns.
14. Monitor calls, outcomes, costs, failures, and compliance blocks.
15. Give clients isolated, white-labeled workspaces.

The first ideal customer is an AI agency or automation freelancer who repeatedly builds voice agents for clients. Secondary customers include appointment-based businesses, clinics, dental practices, real-estate teams, home-service companies, and customer-support operations.

Common use cases include:

- AI receptionist
- Dental or clinic receptionist
- Appointment booking
- Appointment reminders
- Real-estate lead qualification
- Missed-call recovery
- Requested follow-up
- Order confirmation
- Event confirmation
- Customer support triage

VoiceForge must not look like a consumer chatbot, generic voice API, call-center relic, cryptocurrency dashboard, or playful toy. It should feel like a carefully engineered **voice operations studio**.

## 2. Non-negotiable product truths

### Agent Spec JSON is the central contract

VoiceForge does not operate through hidden raw prompts alone. Every agent is represented by a structured, validated specification covering:

- Identity
- Voice
- Goals
- Required fields
- Conversation rules
- Knowledge retrieval
- Tools
- Human handoff
- Compliance
- Analytics
- Conversation flow

Give this concept a recognizable visual language: structured layers, connected decisions, version history, validation status, and inspectable configuration.

### Compliance comes before outbound calling

No outbound call may start until compliance checks pass. The product checks:

- Contact existence
- Consent
- Opt-out status
- Do-Not-Call status
- Local calling window
- Campaign purpose
- AI disclosure
- Recording notice
- Rate and abuse limits

Compliance must appear as an operational safety system, not a marketing badge.

### Multi-tenancy is mandatory

Organizations contain workspaces. Agency workspaces may contain client workspaces. Every agent, call, contact, campaign, credential, and knowledge source is workspace-scoped.

The interface must always make the current workspace and user role understandable without cluttering every screen.

### Provider-neutral architecture

VoiceForge can work with multiple voice and telephony providers. Do not visually tie the product to one provider.

### Tools are controlled actions

Agent tool calls are validated, permissioned, logged, and made idempotent where possible. Integrations are operational capabilities—not decorative logo tiles.

### Privacy matters

Sensitive surfaces include:

- Caller names
- Phone numbers
- Email addresses
- Call recordings
- Live and stored transcripts
- Agent prompts and specifications
- CRM credentials
- Webhook secrets
- Campaign contact uploads
- Compliance records
- Uploaded knowledge
- Client and workspace details

Never use real-looking sensitive data in mockups. Use clearly fictional, partially masked, or structurally representative content.

## 3. Creative direction

### Design concept: “Signal Atelier”

Build a distinctive visual identity combining:

- The precision of a broadcast control room
- The craft of a professional recording studio
- The structure of an operations console
- The editorial confidence of a premium technology publication
- The trust and restraint expected from compliance software

The memorable visual motif should be **the living signal path**: a controlled line representing voice moving from intent, through specification and guardrails, into a real conversation and measurable outcome.

Express this motif through:

- Fine waveform traces
- Routing paths
- Concentric signal rings
- Transcript markers
- Node connections
- Timelines
- Level meters
- Subtle spectral bands
- Operational status pulses

Do not scatter waveform decorations everywhere. Use the motif at meaningful moments: hero imagery, agent builder, live calls, outcomes, and section transitions.

### Overall personality

The product should feel:

- Technical
- Calm
- Exact
- Editorial
- Assured
- Human
- Operational
- Premium without appearing luxurious
- Innovative without appearing speculative
- Dense where work requires density
- Spacious where decisions require focus

Avoid:

- Purple-on-white AI gradients
- Generic blue SaaS branding
- Excessive glowing orbs
- Glassmorphism on every surface
- Huge rounded cards everywhere
- Floating cards with no structural purpose
- Bento grids used indiscriminately
- Robot heads, humanoid AI characters, brains, microphones floating in space, or sci-fi holograms
- Fake browser chrome
- Fake phone-device frames
- Fake terminal windows
- Invented customer logos
- Invented testimonials
- Invented performance claims
- Decorative 3D objects unrelated to calling
- Excessive uppercase micro-labels
- Italic display headlines
- Emoji as interface icons
- Cards nested inside cards without hierarchy

## 4. Color system

Create both light and dark themes, but use them deliberately rather than mechanically inverting every page.

### Primary foundation

Use a deep, near-black **broadcast ink** as the brand foundation:

- Broadcast Ink: approximately `#071310`
- Deep Console: approximately `#0D1C18`
- Dark Elevated Surface: approximately `#142621`

Use a warm, paper-like neutral for light surfaces:

- Studio Paper: approximately `#F3F0E7`
- Raised Paper: approximately `#FBF9F2`
- Pure Operational Surface: approximately `#FFFFFF`

### Brand accent

Use an electrically clear but controlled **signal chartreuse**:

- Signal: approximately `#C7F45A`
- Signal Hover: slightly lighter and warmer
- Signal Dark Text: near-black broadcast ink

Chartreuse is the identifiable brand accent, but it must not cover large application surfaces. Reserve it for:

- Primary marketing CTA
- Active signal indicators
- Successful validation
- Current route markers
- Selected flow connections
- Key focus accents

### Supporting accent

Use a cool spectral cyan:

- Spectrum Cyan: approximately `#61D7E5`

Use cyan for:

- Informational data
- Live monitoring
- Secondary chart series
- Selected technical metadata
- Voice waveform highlights

### Semantic colors

Define distinct, accessible semantic colors:

- Success: controlled green, not chartreuse
- Warning: warm amber
- Danger: clear red
- Information: spectral cyan or cool blue
- Draft/neutral: stone or desaturated slate

Never use color as the only status indicator. Pair every status with text, iconography, shape, or pattern.

### Light and dark theme strategy

- Marketing home: primarily dark, cinematic, signal-led.
- Product explanations and pricing: alternating light editorial surfaces and dark technical demonstrations.
- Main application: light-first for long operational sessions.
- Agent builder and live-call modes: optional darker “studio mode.”
- Public share pages: inherit white-label branding while maintaining accessible system fallbacks.
- Dark theme: designed independently, not generated through simple inversion.

All normal text must meet WCAG AA contrast. Large text should still remain comfortably above minimum contrast.

## 5. Typography

Replace the current generic SaaS feeling with a more distinctive but implementable pairing.

### Display typography

Use **Instrument Sans** or **Manrope** for major product and marketing headings.

Preferred approach:

- Instrument Sans Variable for headlines and product titles
- Weight range: 500–700
- Tight but not compressed tracking
- Upright roman style only
- Strong, short headlines
- No italic headline words

### Body and UI typography

Use **Public Sans** or **IBM Plex Sans** for body copy and application UI.

Requirements:

- Excellent small-size readability
- Neutral enough for dense tables and forms
- Clear distinction among 400, 500, and 600 weights
- Minimum 16px body copy on public/mobile pages
- Application UI may use 14px for compact secondary information, never below 12px

### Data and technical typography

Use **IBM Plex Mono** for:

- Agent Spec keys
- Versions
- Phone numbers
- Durations
- Timestamps
- IDs
- Chart values
- Event payloads
- Tool schema details

Do not use monospace for entire headings or long body paragraphs.

### Type hierarchy

Create reusable styles for:

- Display XL
- Display
- Page title
- Section heading
- Card heading
- Body large
- Body
- UI label
- Supporting text
- Data label
- Monospace value

Use tabular numerals in pricing, duration, costs, usage, timers, and analytics.

## 6. Grid, spacing, and shape language

### Marketing layout

- Maximum content width around 1440px
- Use a 12-column desktop grid
- 32–48px desktop gutters
- 20–24px mobile gutters
- Create asymmetry through deliberate column spans, not random overlap
- Alternate editorial text-led sections with immersive product demonstrations
- Avoid repeating identical centered section-heading/card-grid patterns

### Application layout

- Collapsible left navigation rail on desktop
- Compact top command bar
- Content max width should vary by task:
  - Dashboard and analytics: wide
  - Forms and settings: medium
  - Documentation: readable measure
  - Flow builder: nearly full viewport
- Use 4px base spacing with a practical 8px rhythm
- Support both comfortable and dense data modes where useful

### Shape system

Use:

- 8–12px radii for application controls and panels
- 12–16px for larger marketing imagery
- Pills only for statuses, filters, or compact segmented controls
- Thin, precise borders
- Restrained shadows
- Layering created mostly through contrast, lines, and surface changes
- Avoid making every element a 24px rounded floating card

## 7. Iconography and imagery

### Icons

Use one consistent SVG icon family, preferably Lucide-compatible line icons.

- Standard UI icon: 18–20px
- Compact icon: 14–16px
- Feature icon: 24px
- Consistent 1.5–2px stroke
- Never use emoji as structural icons
- Icon-only controls require labels or accessible tooltips
- Minimum target size: 44×44px

### Hero art direction

The hero must contain a real, high-quality visual composition—not a generic dashboard screenshot placed inside fake browser chrome.

Create a cinematic, editorial split composition:

- Left: concise headline, body copy, primary and secondary actions.
- Right: an abstract-but-product-specific “live signal map.”
- Show a voice request entering the system as a waveform.
- Route it through three meaningful layers:
  1. Agent Spec
  2. Compliance gate
  3. Tool or human handoff
- Resolve into a live transcript and a successful outcome.
- Incorporate fragments of authentic product UI such as a flow node, transcript turn, validation check, and outcome marker.
- Use depth through layered panels, fine grid lines, spectral traces, and subtle noise.
- Do not place a fake browser title bar around the composition.
- Make the visual understandable even without animation.

Suggested hero headline:

**Build the voice operation, not just the voice.**

Suggested supporting copy:

“Describe the agent you need. VoiceForge turns it into a validated operating spec, tests the conversation, enforces compliance, and gives every client a workspace built for real calls.”

Primary CTA: **Build an agent**

Secondary CTA: **Hear a real demo**

Optional tertiary link: **Explore the workflow**

Do not invent customer counts, conversion percentages, or “10× faster” claims.

### Additional visual assets

Create a coherent asset family:

1. Signal-path hero artwork
2. Agent Spec layered diagram
3. Flow-builder product composition
4. Compliance decision map
5. Live-call transcript visualization
6. Agency/client workspace hierarchy
7. Abstract voice spectral textures for section transitions

All images should be exportable in WebP or AVIF, with reserved dimensions to prevent layout shift.

## 8. Marketing website

### Global navigation

Design a sticky navigation that begins transparent over the hero and becomes a solid broadcast-ink bar after scrolling.

Desktop:

- VoiceForge wordmark
- Product
- Solutions
- Workflow
- Compliance
- Pricing
- Resources
- Sign in
- Primary CTA: Build an agent

Use a structured mega-menu for Product and Solutions rather than exposing every destination in one line.

Mobile:

- Wordmark
- Primary CTA
- Menu button
- Full-height accessible navigation sheet
- No horizontally scrolling navigation links

### Homepage structure

Do not use the generic sequence “hero → three features → testimonials → pricing → CTA.”

Use this structural rhythm:

1. **Signal-map hero**
2. **Operational proof strip**
   - “Validated spec”
   - “Compliance before outbound”
   - “Provider-neutral runtime”
   - “Workspace isolation”
   These are product principles, not fabricated metrics.
3. **Interactive workflow**
   - Describe
   - Generate
   - Inspect
   - Test
   - Publish
   - Monitor
4. **Agent Spec section**
   - Explain the central contract
   - Show structured layers and validation
5. **Builder section**
   - Visual flow, node palette, configuration panel, version state
6. **Test-call studio**
   - Audio waveform
   - Live transcript
   - Tool events
   - Latency
   - Evaluation
7. **Compliance gate**
   - Show allowed and blocked decisions
   - Emphasize why a call was blocked and how to resolve it
8. **Agency operating model**
   - Agency workspace
   - Client workspaces
   - Branded delivery
   - Usage and permissions
9. **Provider and integration architecture**
   - Present adapters and capabilities, not a wall of logos
10. **Use-case editorial modules**
    - Receptionist
    - Dental
    - Real estate
    - Appointment reminders
    - Missed-call recovery
11. **Demo-call section**
    - Functional audio player
    - Sample transcript
    - Agent goal and outcome
12. **Final CTA**
    - “Design the first call before it reaches a customer.”

### Solutions pages

Create reusable but structurally varied layouts for:

- Agencies
- Appointment-based businesses
- Healthcare-adjacent operations
- Real estate
- Customer support
- Lead qualification

Do not claim legal certification or compliance guarantees. Phrase regulated-industry material carefully.

### Pricing page

Preserve four plans:

- Free
- Starter
- Growth
- Enterprise

The page must include:

- Clear plan cards
- Current-plan state
- Most-relevant-plan emphasis
- Usage estimator
- Feature comparison
- Demo billing or checkout-paused notice
- Checkout failure state
- Enterprise sales path
- FAQ

On mobile, do not compress the comparison table into unreadable columns. Convert it into plan-by-plan comparison sections or an accessible selected-plan comparator.

### Legal DPA page

Use a restrained document layout:

- Readable width
- Sticky table of contents on desktop
- Clear heading hierarchy
- Print-friendly treatment
- No decorative animation

## 9. Authentication and onboarding

Redesign:

- Sign in
- Sign up
- Email confirmation
- Invite acceptance
- Organization creation
- Workspace creation
- Checkout start, success, and cancellation
- Errors and expired-session states

Use a two-column desktop composition:

- Left: authentication form
- Right: subtle signal-system illustration and a concise explanation of the workflow

On mobile, show the form first and reduce the illustration.

Requirements:

- Persistent visible field labels
- Password visibility toggle
- Inline validation after blur
- Error message adjacent to the relevant field
- First invalid field receives focus after submission
- Google authentication is visually secondary
- Loading buttons preserve width
- Confirmation state clearly explains the next action
- Never expose whether unrelated email addresses exist
- Onboarding should show progress:
  1. Organization
  2. Workspace
  3. First agent
- Preserve safe post-auth redirects

## 10. Application shell

### Desktop navigation

Replace the permanently wide sidebar with a collapsible navigation rail.

Expanded width: approximately 256px  
Collapsed width: approximately 72px

Group navigation as:

**Home**
- Overview

**Build**
- Agents
- Create agent
- Templates
- Knowledge

**Operate**
- Calls
- Phone numbers
- Campaigns
- Analytics

**Connect**
- Integrations
- CRM

**Govern**
- Compliance
- Clients
- White label

**Workspace**
- Billing
- Documentation
- Settings

Bottom region:

- Workspace switcher
- Current role
- Help
- User menu

Use a strong active indicator based on a signal line or filled edge—not merely a tinted rounded rectangle.

### Top command bar

Include:

- Breadcrumbs
- Workspace context
- Global search or command launcher
- Environment/status indicator when relevant
- Notifications
- Contextual primary action

Support a keyboard-accessible command palette for routes, agents, calls, and common actions.

### Mobile navigation

Do not reproduce the full desktop sidebar in a drawer only.

Use:

- Compact top bar
- Bottom navigation with no more than five top-level destinations:
  - Home
  - Agents
  - Calls
  - Analytics
  - More
- “More” opens the complete navigation sheet
- Contextual creation action remains clearly available
- Preserve navigation state and scroll position

## 11. Dashboard overview

Redesign the dashboard as an operational briefing rather than a stack of equal cards.

Hierarchy:

1. Workspace status and primary action
2. Setup or launch progress
3. Live operational metrics
4. Agents requiring attention
5. Recent calls and outcomes
6. Compliance or billing warnings
7. Activity feed

Show:

- Total agents
- Published agents
- Draft agents
- Test calls
- Recent voice agents
- Recent calls
- Getting-started checklist
- Prompt guidance

Improve these concepts:

- Give “requires attention” stronger priority than passive totals.
- Use compact metric cells rather than four oversized cards.
- Provide a meaningful zero-data state.
- Let first-time users see the shortest path to their first test call.
- Let established users see live health, issues, and outcomes first.

## 12. Agent pages and creation flow

### Agents list

Support:

- Search
- Status filter
- Industry filter
- Agent type
- Sort
- Grid/list switch
- Bulk selection where useful
- Published, draft, error, and archived states

Each agent row/card should show:

- Name
- Purpose
- Status
- Active version
- Provider status
- Phone assignment
- Last call
- Recent outcome or health
- Quick actions

### Create agent

Offer three explicit paths:

1. Describe with AI
2. Start from template
3. Build manually

Do not bury these inside tabs without context. Explain who each path suits.

### AI generation

Design a focused generation workspace:

- Large instruction composer
- Suggested prompt structures
- Business and use-case context
- Template selector
- Generated-preview region
- Validation progress
- Editable assumptions
- Clear save-as-draft action

The generation experience should visually communicate that VoiceForge is producing structured configuration—not improvising an opaque prompt.

## 13. Agent builder

This is the product’s signature application surface.

Create a near-full-screen workbench with:

### Top bar

- Back to agents
- Agent name
- Draft/published status
- Active version
- Save state
- Undo/redo
- Test call
- Publish

### Left rail

- Flow node palette
- Search nodes
- Categorized node types:
  - Start
  - Speak
  - Ask question
  - Condition
  - Knowledge lookup
  - Tool call
  - Transfer
  - Send SMS/email
  - Fallback
  - End

### Center canvas

- Node-based flow
- Minimap
- Zoom
- Fit view
- Clear selection
- Keyboard movement
- Accessible non-drag alternatives
- Validation markers
- Selected path emphasis
- Invalid or incomplete paths

### Right inspector

- Selected node configuration
- Labels and helper text
- Tool and knowledge assignment
- Validation errors
- Save state

### Secondary modes

Use an explicit mode switch for:

- Flow
- Spec
- Knowledge
- Test
- Versions
- Launch

Do not place every mode in one vertically scrolling page.

### Agent Spec mode

Use a split editor:

- Structured form on one side
- JSON/Monaco inspection on the other
- Schema validation
- Changed-line indicators
- Clear errors
- Version comparison
- Restore workflow

### Test-call studio

Create a dark, focused test environment:

- Start/end call
- Large call-state indicator
- Live waveform
- Live transcript
- Tool-call events
- Latency indicator
- Handoff event
- Evaluation result
- Suggested improvements
- Save suggested fix
- Return to flow or spec

### Publish flow

Publishing must not be one uncontextualized button.

Show a preflight panel covering:

- Spec validity
- Start/end flow path
- Compliance policy
- Handoff configuration
- Knowledge readiness
- Tool readiness
- Phone/provider readiness
- Test-call status

Allow publishing only when mandatory checks pass. Explain blocked states with recovery actions.

## 14. Calls and live monitoring

### Calls list

Use a real data table on desktop and structured records on mobile.

Include:

- Search
- Date range
- Agent
- Direction
- Provider
- Status
- Outcome
- Duration
- Saved filter views
- Export where authorized

Mask phone numbers by default when full visibility is unnecessary.

### Call detail

Organize the page around a synchronized timeline:

- Call status
- Audio playback or live monitor
- Transcript
- Events
- Tool calls
- Transfers
- Outcome
- Evaluation
- Metadata

Selecting a transcript turn should highlight the corresponding audio/timeline position when possible.

Distinguish agent and caller turns through alignment, label, and subtle surface differences—not color alone.

Provide:

- Copy with permission
- Download with permission
- Redaction indication
- Retention status
- Empty transcript state
- Live reconnecting state
- Failed recording state
- Evaluation unavailable state

Treat this page as private. Do not add decorative analytics or session replay affordances.

## 15. Campaigns

Design campaigns as a guided, compliance-aware workflow.

### Campaign list

Show:

- Campaign name
- Assigned agent
- Status
- Total contacts
- Completed
- Failed
- In progress
- Scheduled window
- Compliance block count
- Pause/resume actions

### Creation flow

Use a persistent stepper:

1. Upload
2. Validate
3. Configure
4. Compliance
5. Review
6. Launch

Include:

- Drag-and-drop CSV upload
- Paste contacts
- Downloadable CSV format example
- Validation summary
- Editable row errors
- Masked contact preview
- Agent selection
- Maximum calls per hour
- Maximum concurrent calls
- Calling windows
- Consent confirmation
- DNC confirmation
- Final launch summary

The final launch action should state the number of contacts affected.

Compliance confirmations must not be hidden inside fine print. Clearly explain that a per-call compliance check still runs before dialing.

## 16. Analytics

Create a dense but readable analytics workspace.

Include:

- Date range
- Workspace/agent scope
- Total calls
- Total minutes
- Success rate
- Answer rate
- Failed-call rate
- Blocked calls
- Call volume over time
- Outcome distribution
- Agent comparison
- Compliance summary
- Per-agent performance table

Improve chart design:

- Avoid relying on pie charts for many categories.
- Use horizontal bars for outcome distributions with more than five categories.
- Label units and time granularity.
- Include accessible legends and direct labels.
- Provide table alternatives.
- Make tooltips keyboard-accessible.
- Allow series toggling.
- Design empty, loading, and failed states.
- Use tabular numerals.
- Do not use gradients that obscure data.
- Provide a concise textual insight above each major chart.
- On mobile, simplify ticks and stack charts vertically.

Never fabricate insights in the default mockup. Use neutral labels such as “No data in this period” or clearly marked sample data.

## 17. Compliance

Treat compliance as a first-class control center.

Primary areas:

- Contacts
- Consent records
- Do-Not-Call list
- Blocked-call reasons
- Allowed calling windows
- Disclosure configuration
- Audit activity

Design a decision-oriented status model:

- Passed
- Blocked
- Needs review
- Expired
- Missing information

Every blocked state must show:

1. What was blocked
2. Why it was blocked
3. Which rule was applied
4. What the user can do next
5. Whether the user has permission to resolve it

Contact details and consent history should use a master-detail layout on desktop and a list-to-detail navigation pattern on mobile.

Destructive actions—revoking consent, opting out, removing DNC entries—must be visually separated and require deliberate confirmation when appropriate.

Do not visually imply that VoiceForge provides legal advice or guarantees legal compliance.

## 18. Knowledge base

Redesign knowledge as a source-management workspace rather than one large card.

Areas:

- Source inventory
- Add source
- Processing status
- Search/retrieval test
- Chunk result inspection
- Agent/workspace scope
- Error recovery

Source types:

- Inline text
- URL
- PDF
- CSV
- TXT
- Markdown

Each source should show:

- Title
- Type
- Scope
- Processing status
- Chunk count
- Last updated
- Agents using it
- Error state if ingestion failed

Use a right-side drawer or dedicated detail view for source inspection.

Retrieval testing should show:

- Query
- Ranked chunks
- Relevance score
- Source
- Chunk index
- Highlighted matching passages

Uploaded knowledge and search queries are sensitive. Use fictional content and clear privacy treatment.

## 19. Integrations and CRM

### Integrations list

Avoid a generic marketplace logo wall.

Distinguish:

- Connected tools
- Available templates
- Custom webhook tools
- CRM connections
- Calendars
- Communication actions

Show operational status:

- Connected
- Needs attention
- Disabled
- Last successful call
- Recent failure
- Agents using the tool

### New tool flow

Use a guided form for:

- Tool name and purpose
- Endpoint
- Method
- Authentication
- Input schema
- Confirmation requirements
- Timeout
- Retry behavior
- Permission scope
- Test request
- Response mapping

Mask credentials. Never render complete secrets after initial entry. Include copy-safe and reveal-with-permission patterns.

### Tool detail

Show:

- Configuration
- Agents using it
- Test console
- Recent calls
- Failure rate
- Audit history
- Disable action
- Credential rotation

## 20. Phone numbers

Design phone-number management around routing and readiness.

Include:

- Number
- Country/region
- Provider
- Assigned agent
- Direction support
- Provisioning state
- Inbound routing
- Outbound readiness
- Compliance readiness
- Port/BYO state

Use a setup wizard for connecting or importing a number.

Do not present credentials or provider secrets in plain text.

## 21. Clients and white-label

### Clients

Present agency operations with:

- Client workspace
- Active agents
- Recent usage
- User count
- Last activity
- Branding status
- Billing or plan context
- Health/attention state

Support:

- Create client workspace
- Invite client admin/viewer
- Switch into client workspace
- View usage
- Manage permissions

Clearly distinguish agency-level context from client-workspace context.

### White-label studio

Create a live branding workbench:

Left:

- Brand name
- Logo
- Primary color
- Custom domain
- Support email
- Hide platform branding
- Client-facing defaults

Right:

- Live dashboard preview
- Public agent page preview
- Light/dark preview
- Accessibility contrast warning
- Desktop/mobile switch

The preview must update immediately without pretending that unsaved changes are already live.

Custom colors must be mapped to safe semantic tokens. If a client-selected color fails contrast, provide a corrected accessible variant.

## 22. Billing and settings

### Billing

Include:

- Current plan
- Renewal state
- Trial state
- Usage
- Limits
- Overage risk
- Invoices
- Payment method
- Upgrade/downgrade
- Demo-billing mode
- Checkout paused/failure states

Use progress bars only when there is a meaningful limit. Pair visual bars with exact values.

### Settings

Group settings into:

- Profile
- Organization
- Workspaces
- Team
- Roles and permissions
- Audit log
- CRM
- Phone numbers
- Data retention
- Security
- Danger zone

Do not make every setting a tab in one horizontal strip. Use secondary side navigation on larger screens and section navigation on mobile.

Audit logs should be structured, filterable, and readable:

- Actor
- Action
- Target
- Workspace
- Time
- Result
- Metadata detail

### Data retention

Make retention policies clear and consequential:

- What data is retained
- Retention duration
- Which data types are affected
- Whether a change affects future or existing records
- Required role
- Confirmation for destructive reductions

## 23. Documentation

Create a documentation experience with:

- Search
- Persistent section navigation
- Quick start
- Core concepts
- Dashboard guide
- Agent Spec reference
- Operational checklists
- Troubleshooting
- Contextual “open in product” links

Use a maximum reading width of approximately 72 characters.

Agent Spec documentation should include structured tables and code sections. Preserve horizontal scrolling only within code/table containers, never on the whole page.

## 24. Public agent share page

This page may be white-labeled and shared with prospects or clients.

It should include:

- Client or agency brand
- Agent name
- Business or use case
- Functional audio sample
- Sample transcript
- Agent capabilities
- Disclosure that this is an AI-generated sample where appropriate
- CTA to create an agent
- Optional “Powered by VoiceForge” based on branding settings

The page must feel like a polished demonstration experience, not an internal dashboard card enlarged to fill the page.

White-label settings must not compromise contrast or interaction accessibility.

## 25. Component system

Create reusable Framer components and variants for:

- Button
- Icon button
- Input
- Textarea
- Select
- Checkbox
- Radio
- Switch
- Tabs
- Segmented control
- Badge
- Status indicator
- Tooltip
- Dropdown
- Command menu
- Breadcrumb
- Card/panel
- Metric cell
- Table
- Mobile data record
- Empty state
- Loading skeleton
- Alert
- Toast
- Dialog
- Side sheet
- Stepper
- Timeline
- Audio player
- Waveform
- Transcript turn
- Event row
- Flow node
- Node connector
- Chart frame
- File upload
- Version row
- Compliance decision
- Workspace switcher
- User menu

Every interactive component needs variants for:

- Default
- Hover
- Focus-visible
- Active/pressed
- Disabled
- Loading
- Error
- Success

Use consistent semantic tokens rather than one-off colors.

## 26. Motion

Motion should communicate signal, causality, and state.

### Hero motion

- Signal line enters from the edge.
- Agent Spec layers resolve sequentially.
- Compliance gate changes from checking to passed.
- Transcript appears turn by turn.
- Outcome marker settles into place.
- Total sequence should remain controlled and under approximately 1.2 seconds after initial load.
- The final static composition must still communicate the complete story.

### Application motion

Use:

- 150–220ms hover and state transitions
- 220–320ms sheets and panels
- Faster exits than entrances
- 30–50ms stagger for compact lists
- Crossfade for data replacement
- Spatial continuity between list and detail
- A restrained pulse for genuinely live status only

Animate only transform and opacity where possible.

Do not animate:

- Long body text
- Every card on scroll
- Focus rings
- Repeated decorative waves
- Width/height in ways that cause layout shift

Respect `prefers-reduced-motion`. Reduced-motion mode should replace spatial movement with short opacity transitions or no animation.

## 27. Responsive behavior

Design and verify at:

- 320px
- 375px
- 414px
- 768px
- 1024px
- 1440px and above

Requirements:

- No page-level horizontal scrolling
- No inaccessible hover-only controls
- Minimum 44×44px touch targets
- Mobile body copy of at least 16px
- Fixed bars reserve space for content
- Tables become mobile records or controlled table scrollers
- Chart labels simplify on narrow screens
- Flow builder provides non-drag and simplified mobile editing paths
- Inspector panels become bottom or full-height sheets
- Primary actions remain reachable without covering content
- Long titles wrap safely
- Buttons and navigation labels should not awkwardly wrap to two lines
- Preserve browser zoom
- Support landscape tablet use

## 28. Accessibility

Target WCAG 2.2 AA.

Include:

- Sequential heading hierarchy
- Skip-to-content link
- Visible focus indicators
- Keyboard-complete navigation
- Logical tab order
- Accessible dialogs and sheets
- Focus return after closing overlays
- Form labels that remain visible
- Errors associated with their fields
- `aria-live` treatment for async success and errors
- Accessible chart summaries
- Table alternatives for charts
- Text/icon accompaniment for color-coded status
- Descriptive image alt text
- Decorative imagery excluded from assistive technology
- Sufficient contrast in both themes
- Reduced-motion support
- Screen-reader-friendly route-change focus
- Keyboard alternatives to drag-and-drop
- Tooltips accessible by focus, not hover alone

## 29. Content and data rules

Use concise, operational language.

Preferred verbs:

- Build
- Generate
- Review
- Test
- Publish
- Connect
- Route
- Monitor
- Resolve
- Block
- Retry
- Restore

Avoid vague copy such as:

- Unlock possibilities
- Revolutionize conversations
- Supercharge engagement
- Transform your business
- Seamless AI magic

Do not invent:

- Customer logos
- Testimonials
- User counts
- Revenue metrics
- Conversion improvements
- Compliance certifications
- Legal guarantees
- Unsupported provider claims

Use clearly fictional sample names and masked data. Example:

- Agent: “Smile Dental Receptionist”
- Contact: “Jordan M.”
- Phone: “+1 ••• ••• 0148”
- Workspace: “Northstar Automation”
- Client: “Harbor Dental Group”

## 30. Framer build requirements

Build this as an organized Framer project with:

- Desktop, tablet, and mobile breakpoints
- Reusable components
- Component variants
- Shared text styles
- Shared color styles
- Shared spacing and radius variables
- Light and dark theme tokens
- Accessible navigation
- Working overlays and menus
- Working tabs and segmented controls
- Functional prototype interactions
- Working audio-player interaction where feasible
- Meaningful hover, focus, disabled, loading, and error states
- CMS-ready structures for use cases, templates, documentation, and FAQs
- Clearly named layers and components
- No flattened page-sized images
- Exportable visual assets
- Implementation notes for complex interactions Framer cannot reproduce faithfully

Framer is responsible for the design and interactive prototype—not reproducing backend behavior. For features requiring real APIs, authentication, telephony, live transcripts, schema validation, file processing, or database writes, design realistic interface states and identify the required implementation handoff.

The final system must be feasible to rebuild using:

- Next.js App Router
- React
- Tailwind CSS 4
- Strict TypeScript
- Radix UI primitives
- Lucide icons
- Recharts
- React Flow
- Monaco Editor
- TipTap
- React Query
- Zod

Do not propose a visual system that depends on canvas-only rendering, unexportable effects, excessive WebGL, or animation that would impair application performance.

## 31. Required page inventory

Produce complete designs for:

### Public and account

- `/`
- `/pricing`
- `/sign-in`
- `/sign-up`
- `/onboarding`
- `/invite/accept`
- `/legal/dpa`
- `/checkout/start`
- `/checkout/success`
- `/checkout/cancel`
- `/a/[slug]`
- Not found
- General error state

### Dashboard

- `/dashboard`
- `/dashboard/agents`
- `/dashboard/agents/new`
- `/dashboard/agents/new/ai-generate`
- `/dashboard/agents/[agentId]/builder`
- `/dashboard/templates`
- `/dashboard/calls`
- `/dashboard/calls/[callId]`
- `/dashboard/campaigns`
- `/dashboard/analytics`
- `/dashboard/knowledge`
- `/dashboard/integrations`
- `/dashboard/integrations/new`
- `/dashboard/integrations/[toolId]`
- `/dashboard/clients`
- `/dashboard/compliance`
- `/dashboard/white-label`
- `/dashboard/billing`
- `/dashboard/docs`
- `/dashboard/settings`
- `/dashboard/settings/crm`
- `/dashboard/settings/phone-numbers`
- `/dashboard/settings/retention`

## 32. Required states

For every major screen, include applicable variants for:

- First-time empty
- Populated
- Loading
- Partial loading
- API failure
- Permission denied
- Offline/reconnecting
- Search with no results
- Validation error
- Saving
- Saved
- Unsaved changes
- Disabled by plan
- Disabled by permissions
- Compliance blocked
- Trial
- Subscription past due
- Checkout paused
- Destructive confirmation
- Success
- Mobile

Do not design only polished happy paths.

## 33. Final deliverables

Deliver:

1. A complete VoiceForge design system.
2. Marketing website.
3. Responsive application shell.
4. Every public and authenticated page listed above.
5. Light and dark themes.
6. Hero visual and art direction.
7. Reusable component library.
8. All key component states.
9. Responsive behavior.
10. Motion specification.
11. Accessibility annotations.
12. Privacy annotations for sensitive surfaces.
13. Framer prototype interactions.
14. Developer handoff notes.
15. A route-by-route inventory showing completion.
16. A list of places where real application behavior must replace Framer prototype behavior.

Before finalizing, audit the result against these questions:

- Does this feel specifically built for voice-agent operations?
- Is Agent Spec visibly central?
- Is compliance visibly operational?
- Does the interface support agency and client workspaces?
- Are the builder, transcript, analytics, and campaign workflows genuinely usable?
- Are sensitive fields treated carefully?
- Can the system be implemented with Next.js and Tailwind?
- Does every important action have loading, error, success, disabled, and focus states?
- Does mobile feel designed rather than collapsed?
- Is the design memorable without looking like a generic AI website?
- Have all invented metrics, testimonials, logos, and legal claims been removed?

The finished product should feel like a **broadcast-grade operating studio for business voice agents**: expressive enough to be memorable, controlled enough to earn trust, and practical enough for users to operate every day.
