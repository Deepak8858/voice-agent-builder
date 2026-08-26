# Vobiz / Vobiz.ai BYO Setup

VoiceForge supports both automatic and manual Vobiz setup.

## Automatic

1. Open `Dashboard -> Phone Numbers`.
2. Select `Connect Number`, choose `Vobiz / Vobiz.ai`, and enter Auth ID plus Auth Token.
3. Leave `Customer auth ID` blank unless you hold Partner API access and are syncing a customer sub-account.
4. Sync and import numbers.
5. Assign an agent and select `Configure`.

VoiceForge uses the documented Vobiz APIs, in this order:

1. `GET /api/v1/partner/accounts/{customer_auth_id}/numbers` — only when a customer Auth ID is set, and only if Partner API access is enabled on the credentials.
2. `GET /api/v1/Account/{account_id}/numbers` — owned DIDs. Master accounts (`MA_`) also see sub-account numbers here.
3. `GET /api/v1/Account/{account_id}/trunks` — fallback for trunk-only setups where no DID is exposed to the API. Imported trunks require a manually entered E.164 number and SIP domain.
4. `PATCH /api/v1/Account/{auth_id}/trunks/{trunk_id}` — inbound routing.

Steps 2 and 3 read `{account_id}` = `customer_auth_id ?? auth_id`, so a Partner
credential syncs the selected customer sub-account rather than the partner
account that authenticates the request. Step 4 always uses `auth_id`, the
authenticated account.

Each step falls through to the next. A step is treated as failed — and the next
one tried — on a non-2xx response, a transport error, a body that is not valid
JSON, or a payload whose list field is not an array. The upstream Vobiz error
body is included in the sync error message when every source fails.

Note: the API path segment `Account` is case-sensitive.

The inbound trunk destination is set to the LiveKit SIP host without the `sip:` prefix.

## Manual

Use manual setup when Vobiz API access is unavailable. Add the E.164 number, optional account/trunk IDs, and optional outbound SIP domain. After LiveKit is configured, copy the displayed SIP host into the Vobiz console and place a test call.
