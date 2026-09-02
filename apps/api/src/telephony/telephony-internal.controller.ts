import { Body, Controller, Post } from '@nestjs/common';
import type {
  HandoffDialRequest,
  HandoffDialResponse,
  InboundCallAdmitRequest,
  InboundCallAdmitResponse,
} from '@voiceforge/shared';
import { HandoffDialRequestSchema, InboundCallAdmitRequestSchema } from '@voiceforge/shared';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TelephonyService } from './telephony.service';

/**
 * Routes the LiveKit agent runtime calls mid-call. @InternalOnly() keeps them
 * off the tenant surface: a workspace user must never be able to admit a call
 * or dial a number by hand.
 *
 * `inbound/admit`: admission for inbound calls that arrive over SIP without a
 * provider webhook (plain SIP trunks, Vobiz, Twilio Elastic SIP trunks). The
 * agent is dispatched first and asks here, with the SIP participant's
 * identity, whether the call is paid for before it speaks.
 *
 * `handoff`: warm transfer. Dials the agent's configured human into the room
 * and answers once they pick up.
 */
@InternalOnly()
@Controller('internal/runtime')
export class TelephonyInternalController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('inbound/admit')
  admit(
    @Body(new ZodValidationPipe(InboundCallAdmitRequestSchema)) body: InboundCallAdmitRequest,
  ): Promise<InboundCallAdmitResponse> {
    return this.telephony.admitSipInboundCall(body);
  }

  @Post('handoff')
  handoff(
    @Body(new ZodValidationPipe(HandoffDialRequestSchema)) body: HandoffDialRequest,
  ): Promise<HandoffDialResponse> {
    return this.telephony.dialHandoff(body);
  }
}
