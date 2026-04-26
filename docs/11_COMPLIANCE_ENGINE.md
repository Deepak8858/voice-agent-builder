# 11 — Compliance Engine

## Note
This is not legal advice. A qualified lawyer should review before production outbound calling.

## Core Rule
No outbound call may start unless the compliance engine returns `passed`.

## Checks
1. Contact exists
2. Consent exists for purpose
3. Contact has not opted out
4. Number is not on DNC/DND list
5. Local call time is allowed
6. Campaign purpose is allowed
7. AI disclosure configured
8. Recording notice configured if recording enabled
9. Abuse/rate limit checks pass

## Decision Format
```json
{
  "status": "blocked",
  "reasons": [
    { "code": "missing_consent", "message": "No valid consent record found." }
  ]
}
```

## Allowed MVP Outbound Purposes
appointment_reminder, missed_call_callback, lead_form_callback, order_confirmation, event_confirmation, requested_follow_up.

## Block by Default
cold_sales, political, debt_collection, healthcare_diagnosis, financial_advice, legal_advice.

## Opt-Out Handling
If caller says stop/remove/do not call/unsubscribe: set contact.opt_out=true, add audit log, end politely, block future outbound calls.
