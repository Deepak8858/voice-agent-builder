# VoiceForge AI — Landing Page Design Spec

**Concept: SIGNAL** — a dark broadcast-console command center for voice AI.
Deliverable: ONE self-contained `index.html` (inline `<style>` + `<script>`, Google Fonts `<link>` only, no frameworks, no external images; all icons inline SVG, 24×24, stroke 1.5).

## 1. Creative Direction

The page reads as a **live ops deck**: near-black ink surfaces, hairline borders, monospace instrument labels, an oscillating waveform, and a transcript terminal that types itself. Two accents create deliberate tension:

- **Vermilion `#ff4a1f`** = action: CTAs, "ON AIR" states, gates opening.
- **Electric cyan `#35e0ff`** = voice: signals, data, transcripts, focus states.

Everything feels measured, gated, and observable — mirroring the product promise (spec-driven, compliance-gated, monitored). Voice: precise, operational, confident. Copy uses ops language ("cleared", "on the air", "gates", "lab").

**Hard departure rule:** the current cream `#f3efe5` / forest `#06130f` / lime `#bfff4a` / serif system is fully retired. No lime, no cream, no serif type, no purple gradients, no Inter/Roboto, no generic glow-on-white SaaS cards.

## 2. Design Tokens (paste as `:root` verbatim)

```css
/* surfaces */
--ink-950:#05070b; --ink-900:#070a0f; --ink-850:#0a0f16;
--ink-800:#0d141d; --ink-700:#121b26;
--line:rgba(148,163,184,.12); --line-strong:rgba(148,163,184,.24);
/* text */
--text-1:#e9eef5; --text-2:#9ba8ba; --text-3:#5f6f83;
/* accents */
--signal:#ff4a1f; --signal-hi:#ff6a3d; --on-signal:#160b06;
--voice:#35e0ff; --voice-dim:rgba(53,224,255,.14);
--pass:#3ecf8e;
/* gradients + glows */
--grad-text:linear-gradient(100deg,#ff4a1f 0%,#ff9a3d 60%,#ffb14a 100%);
--grad-rail:linear-gradient(90deg,#35e0ff,#ff4a1f);
--glow-signal:0 0 24px rgba(255,74,31,.35),0 0 72px rgba(255,74,31,.16);
--glow-voice:0 0 20px rgba(53,224,255,.22);
--shadow-card:0 24px 64px -32px rgba(0,0,0,.72);
/* type */
--f-display:'Space Grotesk',sans-serif; --f-body:'Instrument Sans',sans-serif;
--f-mono:'JetBrains Mono',monospace;
/* radii / layout */
--r-sm:8px; --r-md:12px; --r-lg:16px; --r-pill:999px;
--container:1184px; --gutter:24px; --nav-h:64px;
/* motion */
--ease-out:cubic-bezier(.22,1,.36,1); --ease-std:cubic-bezier(.4,0,.2,1);
--dur-fast:160ms; --dur-med:300ms; --dur-reveal:600ms;
```

**Texture:** `body::before` fixed full-viewport SVG noise data-URI (feTurbulence, fractal, baseFrequency .8), opacity `.035`, `pointer-events:none`, z-index 1 — kills flat-band feel.

**Fonts (Google Fonts, `display=swap`):** Space Grotesk 500/700 · Instrument Sans 400/500/600 · JetBrains Mono 400/500/700.

**Type scale** (all exact):

| Token | Font / weight | Size | Line-height | Letter-spacing | Color |
|---|---|---|---|---|---|
| Display (H1) | Space Grotesk 700 | `clamp(3rem,5.6vw,5rem)` | 1.02 | -0.03em | text-1 |
| H2 | Space Grotesk 700 | `clamp(2.25rem,3.8vw,3.25rem)` | 1.06 | -0.025em | text-1 |
| H3 | Space Grotesk 500 | 1.25rem | 1.25 | -0.01em | text-1 |
| Body-L | Instrument Sans 400 | 1.125rem | 1.6 | 0 | text-2 |
| Body | Instrument Sans 400 | 1rem | 1.65 | 0 | text-2 |
| Mono-label (eyebrows) | JetBrains Mono 500 | .75rem | 1 | .14em uppercase | voice |
| Mono-data | JetBrains Mono 400 | .875rem | 1.55 | 0 | text-2 |

**Spacing rhythm:** 8px base. Section padding `120px 0` desktop / `72px 0` ≤900px. Container `max-width:1184px`, gutters 24px. Card padding 28px. Bento gap 16px. Eyebrow → headline gap 20px; headline → body gap 20px; body → CTA gap 36px.

**Buttons** (height 44px, radius `--r-sm`, font Space Grotesk 600 15px):
- `.btn-primary`: bg `--signal`, color `--on-signal`, padding `0 22px`. Hover: bg `--signal-hi`, `translateY(-1px)`, `--glow-signal`. Active: `translateY(0)`. Transition `160ms var(--ease-std)`.
- `.btn-ghost`: transparent, border `1px solid var(--line-strong)`, color `--text-1`. Hover: border-color `--voice`, color `--voice`.

**Hairline card chrome (signature treatment):** every panel gets `background:var(--ink-800); border:1px solid var(--line); border-radius:var(--r-md); box-shadow:var(--shadow-card)` **plus HUD corner brackets**: `::before`/`::after` 14×14px, 1.5px `--line-strong` L-shaped corners (top-left / bottom-right). Hover: border-color `rgba(53,224,255,.35)`, `translateY(-2px)`, `200ms var(--ease-std)`.

## 3. Section-by-Section Layout

**S0 Nav** — fixed, height `--nav-h`, `backdrop-filter:blur(14px) saturate(140%)`, bg `rgba(7,10,15,.72)`, bottom `1px solid var(--line)`, z 50. Left: logo mark (20×20 `--ink-700` rounded 6px square containing 3 vermilion bars, heights 6/12/8px, gap 2px) + "VoiceForge AI" Space Grotesk 600 15px. Center links: Product, Workflow, Compliance, Pricing — 14px Instrument 500 `--text-2`, hover `--text-1`. Right: status pill (`--r-pill`, 6px cyan dot pulsing + "ALL SYSTEMS OPERATIONAL" mono 11px `--text-3`), "Sign in" ghost (small), "Book a demo" primary (small, height 36px). After `scrollY>24`: add `--shadow-card` (200ms).

**S1 Hero** — `min-height:92vh`, `padding-top:calc(var(--nav-h) + 88px)`, grid `1.05fr .95fr`, gap 64px, items centered. Left: eyebrow `[ SPEC-DRIVEN VOICE OPERATIONS ]` mono-label; H1 **"Ship voice agents that are cleared for the air."** — "cleared for the air." wrapped in span with `--grad-text` on text (`background-clip:text`). Body-L: *"VoiceForge compiles one Agent Spec into tested, compliant, white-labeled calling agents — drafted in natural language, proven in the mock-call lab, deployed to any provider."* CTAs: primary "Start building free" + ghost "Run a mock call →". Below (48px gap): mono-data stat row separated by 1px vertical `--line` dividers: `4 min avg. deploy` · `100% pre-call gate checks` · `SOC 2 Type II`.
Right: **Spec Console card** (max 520px, z above waveform canvas §4.1): header bar 40px `--ink-700` with 3 dots (8px, `--line-strong`) + tabs mono 12px `[Spec] [Prompt] [Call log]` (Spec active: text-1 + 2px bottom `--voice`) + right-aligned `LIVE` chip (`--r-pill`, vermilion dot pulse, mono 10px). Body: JetBrains Mono 13px/1.7 JSON, keys `--voice`, strings `#ffb14a`, punctuation `--text-3`:
`{ "agent":"atlas-support", "voice":"ember-f-2", "persona":"calm, concise", "gates":["dnc","tcpa-consent","rec-disclosure"], "handoff":{"to":"human","when":"sentiment < -0.4"} }` (pretty-printed, 8 lines). Footer row: `✓ SCHEMA VALID` / `✓ 3 GATES ARMED` in `--pass` mono 11px + right chip `v42 → deploy` (`--voice-dim` bg, `--voice` text, `--r-pill`). Card has cursor-tracked sheen (§4.3) + `--glow-voice` behind at 40%.

**S2 Social proof strip** — full-width, top+bottom `1px solid var(--line)`, padding `28px 0`. Left-fixed mono-label "TRUSTED BY VOICE TEAMS AT" (shrink 0, margin-right 48px); marquee (§5) of 6 wordmarks in Space Grotesk 500 18px `--text-3`, hover `--text-1`: NORTHWIND HEALTH · DIALBASE · FERROUS FINANCIAL · ALTAIR INSURANCE · BEACON REALTY · LOOPWELL.

**S3 Workflow** — eyebrow `[ HOW IT WORKS ]`; H2 "From spec to live in four moves." Under headline: horizontal rail (height 2px `--ink-700`, radius 2px) with scroll-linked fill using `--grad-rail` (§4.4). 4-col grid below (gap 24px, margin-top 40px); each step: mono vermilion number `01`–`04` (JetBrains Mono 700 13px), H3 title, body 15px 2 lines:
1. **Draft the spec** — Describe the agent in natural language; VoiceForge compiles it to Agent Spec JSON — the contract everything obeys.
2. **Pass the gates** — DNC, consent, disclosure, and jurisdiction checks run before a single number is dialed.
3. **Prove it in the lab** — Mock-call synthetic personas; inspect transcripts, latency, and intent handling.
4. **Deploy & monitor** — Ship to Vapi, Retell, or Twilio through one adapter; watch live transcripts and analytics.

**S4 Features bento** — eyebrow `[ THE PLATFORM ]`; H2 "Every call accounted for." Grid `repeat(6,1fr)`, gap 16px. Card A (col span 4, row span 2, min-height 420px) **Provider adapters**: center diagram — 96px `--ink-700` rounded square labeled "AGENT SPEC" mono, three 44px chips VAPI / RETELL / TWILIO (`--r-pill`, `--line` border) connected by 1px `--line-strong` lines that dash-animate (§5). Card B (span 2) **Compliance gates**: 3 stacked rows — tick (`--pass` circle-check 16px) + mono 13px labels DNC SCRUB / CONSENT / DISCLOSURE. Card C (span 2) **Mock call lab**: mini static waveform (24 cyan bars, heights 20–100%, 3px wide, gap 3px, opacity .8). Row 3, three span-2 cards: **Workspaces** ("Every tenant isolated, every record scoped."), **White-label portals** ("Your brand on client dashboards — domain, logo, palette."), **Transcripts + analytics** ("Searchable transcripts, sentiment, and conversion metrics per agent."). All cards use hairline chrome + HUD corners; titles H3; copy Body 15px.

**S5 Live transcript terminal (hero demo moment)** — bg `--ink-850` band, top/bottom hairlines. Grid `5fr 7fr`, gap 64px, centered. Left: eyebrow `[ MOCK CALL LAB ]`; H2 "The lab never sleeps."; Body-L: *"Run your spec against synthetic personas before a real customer ever hears it."* Persona chips (`--r-pill`, `--line` border, mono 12px): FRIENDLY BUYER (active: `--voice-dim` bg), SKEPTICAL CFO, ANGRY CUSTOMER — clicking restarts the script with that persona's lines. Right: terminal panel (hairline chrome, height 400px, padding 24px, mono 13px/1.8, `overflow:hidden`) that self-types (§4.2): speaker tag `AGENT` in `--voice` 700, `CALLER` in `--signal` 700, message text `--text-1`. Script: AGENT *"Hi Mara — this is Atlas from Northwind HVAC confirming tomorrow's 2 PM maintenance visit."* / CALLER *"Can we push it to Thursday morning?"* / AGENT *"Thursday between 9 and 11 works. I've updated the appointment — anything else?"* Inline chips fade in after line 2: `intent: reschedule ✓` `sentiment: neutral→positive` `latency 380ms` (mono 10px, `--r-pill`, `--ink-700` bg, `--pass`/`--voice`/`--text-3` text). Blinking block cursor: 8×16px `--voice`, `steps(1)` 1s.

**S6 Compliance / trust** — bg `--ink-900`. Grid `1fr 1fr`, gap 64px. Left: eyebrow `[ COMPLIANCE ]` in `--signal`; H2 "Compliance isn't a feature. It's the gate."; Body-L: *"No outbound call runs until every gate passes. Audit logs are written for each decision."* **Gate visual:** 480px track (height 48px, `--r-pill`, `--ink-800`, border `--line`) with sliding vermilion panel that reveals `CLEARED FOR OUTBOUND` mono 12px letterspaced .2em on scroll-into-view (§5). Right: checklist card, 5 rows (border-bottom `--line`, padding 14px 0): circle-check 16px `--pass` + Body 15px `--text-1` + right mono 11px `--text-3`: DNC registry scrub `~40ms` · TCPA consent verification `~35ms` · Jurisdiction calling hours `~12ms` · Call-recording disclosure `armed` · STIR/SHAKEN caller ID `attested`. Below: badge chips row (`--r-pill`, `--line` border, mono 11px `--text-2`, padding 8px 14px): SOC 2 TYPE II · GDPR READY · HIPAA-READY · STIR/SHAKEN.

**S7 CTA finale** — centered, padding `160px 0 140px`, background `radial-gradient(720px 320px at 50% 100%,rgba(255,74,31,.18),transparent 70%)` + faint waveform strip (reuse canvas, 30% amplitude). H2 display-size: **"Put your agents on the air."** ("on the air" in `--grad-text`). Email capture: single row — input (height 52px, width 340px, `--ink-800`, border `--line`, `--r-sm`, mono 14px placeholder "ops@yourcompany.com", focus border `--voice` + `--glow-voice`) + primary button height 52px "Request sandbox access". Micro-copy mono 11px `--text-3`, margin-top 16px: `FREE SANDBOX · NO CREDIT CARD · DEPLOY IN A DAY`.

**S8 Footer** — bg `--ink-950`, top hairline, padding `72px 0 40px`. 4 link columns (Product / Company / Resources / Legal): header mono 11px `--text-3` uppercase, links 14px `--text-2`, hover `--text-1`, 10px row gap. Right side: status pill + `© 2026 VoiceForge AI`. Bottom: watermark "VOICEFORGE" full-width, Space Grotesk 700 `clamp(80px,14vw,200px)`, color transparent, `-webkit-text-stroke:1px rgba(148,163,184,.14)`, `user-select:none`, line-height .8, margin-top 64px.

## 4. Signature Moments (vanilla JS/CSS)

**4.1 Waveform canvas (hero, behind console card; reused in S7 at 30%)** — `<canvas>` absolutely positioned right-column, 64 bars. rAF loop: `h[i] = base * (sin(t*1.3 + i*.32)*.5 + sin(t*.7 + i*.11)*.5)`, base 90px, bars 4px wide / 6px gap, fill vertical gradient `--voice` → `--signal` (top→bottom), opacity .5, blur-free. Pointer influence: amplitude multiplier `1 + .6*exp(-((i-cursorBar)^2)/50)`. Pause via IntersectionObserver when offscreen; reduced-motion → render one static frame.

**4.2 Self-typing transcript (S5)** — char interval `22ms ± 8ms` randomized; 400ms pause at line breaks; persona click swaps script + resets. Auto-scroll `scrollTop = scrollHeight` per char (smooth). Chips `fade-in + translateY(4px)` 300ms after their trigger line. Loops after 2.4s hold. Reduced-motion → full transcript rendered instantly.

**4.3 Cursor-tracked sheen (Spec Console card)** — `pointermove` sets `--mx`/`--my` (px) on card; `card::after{background:radial-gradient(480px circle at var(--mx) var(--my),rgba(53,224,255,.09),transparent 45%)}`. Lerp values in rAF for smoothness (factor .12).

**4.4 Scroll choreography** — `.reveal` on all section blocks: `opacity:0; translateY(16px)` → in-view `opacity:1; none`, `600ms var(--ease-out)`, stagger via `transition-delay:calc(var(--i)*80ms)` (index set inline). Rail fill in S3: `width = clamp(0, sectionProgress*100%)` on scroll (throttled by rAF). Single IntersectionObserver, threshold .2, rootMargin `0px 0px -10%`, `once:true` for reveals.

## 5. Motion Spec (exact)

- Reveal: `600ms var(--ease-out)`, opacity+translateY only, stagger 80ms.
- Hover lifts (cards, buttons): `160–200ms var(--ease-std)`, transform/opacity/border-color only.
- Marquee: `28s linear infinite`, duplicated track `translateX(-50%)`, `animation-play-state:paused` on hover.
- Status dots / LIVE chip: pulse ring `@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(53,224,255,.5)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}` 2s infinite.
- Gate slide (S6): `translateX(-100%)→0`, `700ms var(--ease-out)`, delay 300ms after in-view.
- Adapter diagram dashes: `stroke-dashoffset` 0→-24, 1.2s linear infinite.
- Nav shadow toggle: 200ms. **Never animate width/height/top/left on scroll.**
- `@media (prefers-reduced-motion:reduce)`: all animations/transitions `0.01ms`; marquee paused; waveform static; transcript instant; gate pre-opened; reveals shown.

## 6. Responsive + Accessibility

**Breakpoints:** ≤1080px bento A→span 6, B/C→span 3; ≤960px nav center links hidden → menu button (44×44px, `aria-expanded`) opening full-screen `--ink-900` overlay, links Space Grotesk 500 28px, staggered reveal; ≤900px hero/transcript/compliance stacks to 1 column (console/terminal below copy), section padding 72px; ≤720px workflow → vertical rail (rail rotates 90°, fill = height), footer 2-col, email capture stacks (input 100% width), watermark 18vw.

**Accessibility (non-negotiable):**
- Contrast on `--ink-900`: `--text-1` ≈ 15:1, `--text-2` ≈ 8:1, `--voice` ≈ 11:1, `--signal` ≈ 5.3:1 (small text on signal accents uses `--signal-hi`); primary button `--on-signal` on `--signal` ≈ 4.8:1.
- Focus: `:focus-visible{outline:2px solid var(--voice); outline-offset:3px; border-radius:inherit}` on every interactive element.
- Skip-link first in DOM. Landmarks: `nav/main/section/footer` with `aria-label`s; H1 once.
- Canvas `role="presentation"`; transcript terminal `aria-hidden="true"` + visually-hidden static summary paragraph; marquee `aria-hidden` with duplicate list hidden from AT.
- All tap targets ≥44×44px; status pill readable (not color-only: includes text).
- `prefers-reduced-motion` honored per §5; no autoplaying audio anywhere.
