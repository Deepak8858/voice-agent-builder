# Superseded — see `VOICEFORGE_AUDIT_REPORT.md`

This document was a Next.js frontend security audit dated 2026-05-01. It described
a Clerk-era `apps/web` that no longer exists. Its principal findings — permissive
CSP, open redirects, and missing form validation — have since been fixed: the CSP
is now nonce-based with `strict-dynamic` (`apps/web/lib/content-security-policy.ts:8-9`),
and redirect targets are constrained by `safeRedirectPath`
(`apps/web/lib/safe-redirect.ts`).

Its contents were removed rather than retained, because a stale audit misstates the
current risk posture.

**Use `VOICEFORGE_AUDIT_REPORT.md` at the repository root.** That report is
reconciled against current code and accounts for each item from this document in its
"Prior audit reconciliation" section.
