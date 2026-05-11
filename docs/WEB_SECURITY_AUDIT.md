# VoiceForge AI — Next.js Frontend Security Audit

**Scope:** `apps/web` (Next.js App Router)  
**Date:** 2026-05-01  
**Auditor:** Kimi-K2.6 (static analysis)

---

## Executive Summary

The frontend has **no active XSS vectors** and **no server-only secrets are leaking into the client bundle**, but it suffers from **missing edge middleware**, **no Content-Security-Policy**, **weak client-side input validation**, and a **blind open-redirect** in billing flows.

| Severity | Count |
|----------|-------|
| HIGH     | 2 |
| MEDIUM   | 2 |
| LOW      | 4 |
| INFO     | 2 |

---

## 1. XSS Vulnerabilities

- **No usage of `dangerouslySetInnerHTML`** found. React's default escaping protects against HTML injection.
- Dynamic user content is rendered as text children. Safe as long as backend returns plain text.
- **INFO** — Attack surface exists only if backend returns unsanitised HTML.

---

## 2. Content-Security-Policy (CSP)

`next.config.ts` contains **zero security headers**. There is no CSP, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` configured.

**Risk:** HIGH — Without CSP, a successful XSS or supply-chain attack can execute arbitrary scripts.

**Fix:** Add a strict Clerk/Stripe-compatible CSP via `next.config.ts`.

---

## 3. Auth State Validation

- **Edge middleware is now properly implemented** via `apps/web/middleware.ts`.
- `SUPABASE_JWT_SECRET` is server-side only, validated at API layer via `SupabaseAuthService`.

**Risk:** HIGH — Unauthenticated users can view agent-creation forms, tool panels, compliance editor, etc.

**Fix:**
1. Rename `apps/web/proxy.ts` to `apps/web/middleware.ts`.
2. Add a client-side `AuthGate` component wrapping dashboard pages.

---

## 4. API Key Exposure

- `CLERK_SECRET_KEY` lives in `.env.local` and is **not referenced in client bundle code**.
- Public-by-design env vars correctly prefixed with `NEXT_PUBLIC_`.
- `lib/api.ts` imports `'server-only'`, ensuring tree-shaking from client.

**Risk:** INFO — No client-side leakage detected.

---

## 5. CSRF Protection

- `use-api.ts` attaches Clerk JWT as `Authorization: Bearer <token>` and sets `credentials: "include"`.
- **No CSRF tokens** on mutating requests.
- App relies on custom `Authorization` header and CORS preflight for cross-origin protection.

**Risk:** LOW–MEDIUM — If backend ever falls back to cookie-based session validation, CSRF becomes trivial.

**Fix:** Add a non-simple custom header (`X-Requested-With: XMLHttpRequest`) to every API request.

---

## 6. Input Validation

- **`zod` and `@hookform/resolvers` are installed but completely unused.**
- Every form uses raw `useState` strings with minimal guards:
  - `NewAgentPage`: button disabled only when `prompt.length < 10`.
  - `WhiteLabelPanel`: no email, URL, or hex-color validation.
  - `KnowledgePanel`: URL type accepts any string.
  - `CompliancePanel`: phone numbers have no format validation.
  - `NewToolPage`: webhook URL is unvalidated.
- `white-label-panel.tsx` injects raw `primary_color` into inline CSS.

**Risk:** MEDIUM — Malformed payloads hit API, leading to 500s or downstream injection.

**Fix:** Introduce shared Zod schemas and use on every form.

---

## 7. Sensitive Data in URLs

1. **Knowledge search leaks PII in logs & history.** Query sent as GET parameter.
2. **Billing `returnUrl` snapshots full current URL.** If a token is in the URL, it forwards to Stripe.
3. Resource IDs in URL paths acceptable for UUIDs.

**Risk:** LOW

**Fix:** Convert knowledge search to POST endpoint; sanitize billing return URLs.

---

## 8. Open Redirect (Billing Panel)

`billing-panel.tsx` blindly assigns API response to `window.location.href`.

**Risk:** MEDIUM — If endpoint is compromised, user redirected to attacker site.

**Fix:** Validate redirect URL against Stripe domain allow-list before navigation.

---

## Remediation Checklist

| # | Task | File(s) | Priority |
|---|------|---------|----------|
| 1 | Add CSP + security headers to `next.config.ts` | `next.config.ts` | HIGH |
| 2 | Verify Supabase middleware auth on staging before removing AuthGate fallback | `middleware.ts` | HIGH |
| 3 | Add `AuthGate` wrapper to all client dashboard pages | Multiple | MEDIUM |
| 4 | Validate open-redirect URLs in billing panel | `billing-panel.tsx` | MEDIUM |
| 5 | Add `X-Requested-With` header to all API calls | `lib/use-api.ts`, `lib/api.ts` | LOW |
| 6 | Replace raw `useState` forms with `react-hook-form` + `zod` schemas | Multiple | LOW |
| 7 | Validate `primary_color` as hex to prevent style injection | `white-label-panel.tsx` | LOW |
| 8 | Convert knowledge search from GET query params to POST body | `knowledge-panel.tsx`, API | LOW |
| 9 | Rotate `SUPABASE_JWT_SECRET` and `JWT_SECRET` periodically | `.env` | INFO |
| 10 | Audit health route for information disclosure | `app/api/health/route.ts` | INFO |
