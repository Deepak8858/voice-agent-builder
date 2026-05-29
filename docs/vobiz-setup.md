# Vobiz / Vobiz.ai BYO Setup

VoiceForge supports both automatic and manual Vobiz setup.

## Automatic

1. Open `Dashboard -> Phone Numbers`.
2. Select `Connect Number`, choose `Vobiz / Vobiz.ai`, and enter Auth ID plus Auth Token.
3. If using partner inventory, include the customer Auth ID.
4. Sync and import numbers.
5. Assign an agent and select `Configure`.

VoiceForge uses the documented Vobiz APIs:

- `GET /api/v1/partner/accounts/{customer_auth_id}/numbers`
- `GET /api/v1/Account/{auth_id}/trunks`
- `PATCH /api/v1/Account/{auth_id}/trunks/{trunk_id}`

The inbound trunk destination is set to the LiveKit SIP host without the `sip:` prefix.

## Manual

Use manual setup when Vobiz API access is unavailable. Add the E.164 number, optional account/trunk IDs, and optional outbound SIP domain. After LiveKit is configured, copy the displayed SIP host into the Vobiz console and place a test call.
