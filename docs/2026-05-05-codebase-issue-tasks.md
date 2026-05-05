# Codebase issue triage (2026-05-05)

## 1) Typo fix task
**Issue:** `README.md` contains a malformed relative path (`docs/..`) in the sentence that points readers to documentation order.

**Task:** Replace `docs/..` with a valid path (likely `docs/README-order.md`) and verify the sentence reads cleanly.

**Acceptance criteria:**
- The incorrect `docs/..` fragment is removed.
- The documentation pointer is unambiguous and clickable in GitHub preview.

## 2) Bug fix task
**Issue:** In the server-side web API helper, `content-type: application/json` is always set even when `FormData` bodies may be passed. This can break multipart boundaries and file upload behavior.

**Task:** Update `apps/web/lib/api.ts` to mirror the safer logic used in `apps/web/lib/use-api.ts`: only set JSON `content-type` when the request body is not `FormData` and no explicit content-type is already present.

**Acceptance criteria:**
- `apiFetch` does not force JSON content-type for multipart requests.
- Existing JSON calls still work without callers setting headers manually.
- Add or update unit/integration coverage around header behavior.

## 3) Documentation discrepancy task
**Issue:** Root `README.md` states "Phase 6 onwards ... is not yet implemented," but the repository already contains Phase 6+ modules (compliance, analytics, white-label, billing) in `apps/api/src/`.

**Task:** Reconcile README status text with actual implementation state by either:
- updating the phase-completion summary, or
- explicitly listing what's partial vs complete.

**Acceptance criteria:**
- README status section matches current code reality.
- Any unfinished areas are marked as partial instead of blanket "not implemented."

## 4) Test improvement task
**Issue:** `apps/api/src/calls/calls.service.ts` swallows transcript-provider errors in `get()` via a bare `catch` and silently returns empty turns. This behavior is intentional for resilience, but there is no explicit regression test proving failure isolation.

**Task:** Add a unit test for `CallsService.get()` that forces `voice.getTranscript()` to throw and verifies:
- the call detail request still succeeds,
- `turns` is an empty array,
- persisted `transcript_text` is still returned,
- evaluation lookup still runs.

**Acceptance criteria:**
- New test fails before the behavior exists and passes after.
- The resilience behavior is documented by the test name and assertions.
