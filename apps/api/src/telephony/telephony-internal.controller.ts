import { Body, Controller, Post } from '@nestjs/common';
import type { InboundCallAdmitRequest, InboundCallAdmitResponse } from '@voiceforge/shared';
import { InboundCallAdmitRequestSchema } from '@voiceforge/shared';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TelephonyService } from './telephony.service';

/**
 * Admission for inbound calls that arrive over SIP without a provider webhook
 * (plain SIP trunks, Vobiz, Twilio Elastic SIP trunks). The LiveKit agent is
 * dispatched first and asks here, with the SIP participant's identity, whether
 * the call is paid for before it speaks. @InternalOnly() keeps this off the
 * tenant surface: a workspace user must never be able to admit a call by hand.
 */
@InternalOnly()
@Controller('internal/runtime/inbound')
export class TelephonyInternalController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('admit')
  admit(
    @Body(new ZodValidationPipe(InboundCallAdmitRequestSchema)) body: InboundCallAdmitRequest,
  ): Promise<InboundCallAdmitResponse> {
    return this.telephony.admitSipInboundCall(body);
  }
}
