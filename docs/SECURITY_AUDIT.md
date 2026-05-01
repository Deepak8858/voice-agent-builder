# VoiceForge AI — NestJS API Security Audit Report

**Scope:** `apps/api/src` (NestJS backend)  
**Date:** 2026-05-01  
**Auditor:** Automated comprehensive static analysis  
**Overall Risk Score:** 62 / 100 (HIGH)

---

## Executive Summary

The VoiceForge API has a solid tenancy model (workspace-scoped Prisma queries are the norm) and correctly validates most user-facing DTOs with Zod. However, several CRITICAL and HIGH severity issues remain, primarily around:

1. **Publicly exposed operational endpoints** (`/metrics`, `/health`) bound to `0.0.0.0` without authentication.
2. **Mock authentication implementation** that uses unsigned, non-`secure` cookies containing raw user IDs — trivially forgeable.
3. **Missing webhook signature verification** on the voice-provider ingress path.
4. **Unvalidated redirect URLs** passed to Stripe and stored as white-label settings.
5. **Broken rate-limiting infrastructure** — the guard exists but is applied nowhere, and its skip decorator is non-functional.

A determined attacker could scrape metrics, forge session cookies (if the mock auth path is active), exploit open redirects in billing flows, and flood unguarded webhook/auth endpoints.

---

## 1. Authorization Gaps

### 1.1 CRITICAL — `MetricsController` exposed without authentication
- **File:** `apps/api/src/common/metrics.controller.ts`
- **Issue:** The Prometheus `/metrics` endpoint has **no guard or middleware**. The inline comment claims "API port 4000 is bound to 127.0.0.1 only," but `main.ts` explicitly binds to `0.0.0.0` (line 75). In production this leaks runtime metrics, request counts, and route cardinality to the public internet.
- **Fix:** Require a bearer token or IP-range middleware on `/metrics`, or bind the metrics server to a separate private port.

### 1.2 HIGH — Auth endpoints lack brute-force protection
- **File:** `apps/api/src/auth/auth.controller.ts`
- **Issue:** `POST /auth/signup` and `POST /auth/login` are unprotected by `RateLimitGuard` (or any throttle). An attacker can enumerate emails or brute-force the trivial mock cookie scheme at high speed.
- **Fix:** Apply `@UseGuards(RateLimitGuard)` to `AuthController`, or add a NestJS `ThrottlerModule` with aggressive limits on `/auth/*`.

### 1.3 HIGH — Voice webhook has no authentication
- **File:** `apps/api/src/calls/voice-webhook.controller.ts`
- **Issue:** `POST /voice/webhooks/:provider` is completely open. A bad actor can inject fake call events (e.g., `call.ended`) and pollute transcripts, usage records, and compliance audit trails.
- **Fix:** Add HMAC signature verification per provider (Vapi/Retell) before calling `ingestEvent`.

---

## 2. Workspace Scoping

### 2.1 MEDIUM — `BillingController.getUsage` ignores URL workspace parameter
- **File:** `apps/api/src/billing/billing.controller.ts`
- **Issue:** The route is `/workspaces/:workspaceId/billing/usage` and is guarded by `WorkspaceGuard`, but the handler uses `user.active_workspace_id` instead of `req.params['workspaceId']`.
- **Fix:** Use `@Param('workspaceId')` consistently.

---

## 3. SQL Injection

- **Status:** No raw string concatenation into SQL was found. All Prisma queries use parameterized object inputs. **No actionable issue.**

---

## 4. Mass Assignment

### 4.1 HIGH — `BillingController` passes raw `req.body` to Stripe
- **File:** `apps/api/src/billing/billing.controller.ts`
- **Issue:** `createCheckout` and `createPortal` cast `req.body` to DTO interfaces but **do not run `ZodValidationPipe`**. Extra fields in the JSON payload are forwarded into Stripe session creation objects.
- **Fix:** Apply `ZodValidationPipe` with a strict Zod schema.

### 4.2 MEDIUM — `AgentsController.updateFlow` accepts unvalidated body
- **File:** `apps/api/src/agents/agents.controller.ts`
- **Issue:** `@Body() body: { nodes: unknown[]; edges: unknown[] }` has no validation pipe.
- **Fix:** Define a Zod schema for the flow shape and enforce it with `ZodValidationPipe`.

---

## 5. Webhook Security

### 5.1 HIGH — Voice webhook lacks signature verification
- **File:** `apps/api/src/calls/voice-webhook.controller.ts`
- **Issue:** The comment explicitly admits HMAC verification is deferred to "Phase 6." Until then, injected webhook payloads are fully trusted.
- **Fix:** Implement provider-specific signature validation before `calls.ingestEvent()`.

### 5.2 LOW — Stripe webhook signature verified correctly
- **Verdict:** Uses `stripe.webhooks.constructEvent(payload, signature, secret)`. **No issue.**

### 5.3 LOW — Clerk webhook signature verified correctly
- **Verdict:** Uses `svix` `Webhook.verify()`. **No issue.**

---

## 6. File Upload Risks

### 6.1 MEDIUM — `KnowledgeController.upload` trusts client-supplied MIME type and filename
- **File:** `apps/api/src/knowledge/knowledge.controller.ts`
- **Issue:** `file.mimetype` and `file.originalname` are supplied by the HTTP client. No sanitization of `originalname`, allowing path-traversal filenames.
- **Fix:** Sanitize filename, validate magic bytes, reject path separators.

---

## 7. Secret Leakage

### 7.1 CRITICAL — `MockAuthService` uses unsigned, non-secure session cookies
- **File:** `apps/api/src/auth/mock-auth.service.ts`
- **Issue:** `secure: false` is hardcoded. The cookie value is a raw user ID with no HMAC signature or JWT wrapping.
- **Fix:** Replace mock auth with signed JWTs or at minimum a signed cookie, and set `secure: isProduction()`.

### 7.2 LOW — `HttpExceptionFilter` does not leak secrets in responses
- **Verdict:** Stack traces are never returned to the client. **No issue.**

---

## 8. Rate Limiting Gaps

### 8.1 HIGH — `RateLimitGuard` is never applied
- **File:** `apps/api/src/common/rate-limit.guard.ts`
- **Issue:** The guard is exported by `RateLimitModule` but **no controller applies `@UseGuards(RateLimitGuard)`**.
- **Fix:** Apply the guard globally or to high-risk controllers.

### 8.2 LOW — `SkipRateLimit` decorator is non-functional
- **File:** `apps/api/src/common/rate-limit.guard.ts`
- **Issue:** `Reflect.defineMetadata(SKIP_RATE_LIMIT_KEY, true, {})` attaches metadata to a transient `{}` instead of the route handler.
- **Fix:** Use a standard NestJS decorator factory: `SetMetadata(SKIP_RATE_LIMIT_KEY, true)`.

---

## 9. CORS

### 9.1 MEDIUM — `credentials: true` combined with dynamic origin list
- **File:** `apps/api/src/main.ts`
- **Issue:** If an operator accidentally includes a wildcard or attacker-controlled domain in `ALLOWED_ORIGINS`, session theft becomes possible because the mock cookie is not `SameSite=strict`.
- **Fix:** Add an assertion that `ALLOWED_ORIGINS` is non-empty in production.

---

## 10. Error Exposure

### 10.1 HIGH — Unexpected errors leak internal messages in production
- **File:** `apps/api/src/common/http-exception.filter.ts`
- **Issue:** For unhandled exceptions, the filter returns `error.message = exception.message`. Prisma errors often leak schema topology.
- **Fix:** Sanitize non-HTTP exceptions in production.

---

## 11. Open Redirects

### 11.1 HIGH — Stripe checkout/portal URLs are not validated
- **File:** `apps/api/src/billing/billing.controller.ts`
- **Issue:** `successUrl`, `cancelUrl`, and `returnUrl` are passed directly to Stripe.
- **Fix:** Validate that URLs are same-origin or relative.

### 11.2 MEDIUM — White-label settings accept arbitrary URLs/domains
- **File:** `apps/api/src/white-label/white-label.service.ts`
- **Issue:** `logo_url` and `custom_domain` are stored without protocol/hostname validation.
- **Fix:** Validate `logo_url` starts with `https://`, and validate `custom_domain` with a domain regex.

---

## 12. IDOR (Insecure Direct Object Reference)

### 12.1 HIGH — Any authenticated user can accept any client invite
- **File:** `apps/api/src/white-label/white-label.service.ts`
- **Issue:** `acceptInvite` verifies the token exists but **never checks that `user.email === invite.email`**.
- **Fix:** Add email verification before accepting.

---

## Remediation Priority Matrix

| Priority | Issue | Severity | Files |
|----------|-------|----------|-------|
| P0 | Metrics endpoint public on `0.0.0.0` | CRITICAL | `common/metrics.controller.ts`, `main.ts` |
| P0 | Mock auth cookie forgery (`secure:false`, unsigned) | CRITICAL | `auth/mock-auth.service.ts` |
| P1 | Voice webhook has no signature verification | HIGH | `calls/voice-webhook.controller.ts` |
| P1 | Open redirect via unvalidated Stripe URLs | HIGH | `billing/billing.controller.ts` |
| P1 | Raw `req.body` in billing (mass assignment) | HIGH | `billing/billing.controller.ts` |
| P1 | Invite accept lacks email verification | HIGH | `white-label/white-label.service.ts` |
| P1 | No rate limiting on auth/webhooks | HIGH | `auth/auth.controller.ts`, `common/rate-limit.guard.ts` |
| P1 | Internal error messages exposed in production | HIGH | `common/http-exception.filter.ts` |
| P2 | File upload trusts client mime/filename | MEDIUM | `knowledge/knowledge.controller.ts` |
| P2 | CORS `credentials:true` without production guard | MEDIUM | `main.ts` |
| P2 | Billing usage ignores URL workspace | MEDIUM | `billing/billing.controller.ts` |
| P2 | Agent flow update unvalidated | MEDIUM | `agents/agents.controller.ts` |
| P2 | White-label logo_url/custom_domain unvalidated | MEDIUM | `white-label/white-label.service.ts` |
| P3 | Rate-limit skip decorator broken | LOW | `common/rate-limit.guard.ts` |
| P3 | Health endpoint public | LOW | `health/health.controller.ts` |

## Positive Security Controls Observed

1. Workspace scoping is the default across services.
2. Zod DTOs defined for nearly all create/update payloads.
3. Stripe webhook signatures verified with `constructEvent`.
4. Clerk webhook signatures verified with `svix`.
5. Global exception filter never returns stack traces to the client.
6. Audit logging instrumented on all mutating operations.
7. Helmet applied for security headers (`hsts`, `noSniff`, `frameguard`).
