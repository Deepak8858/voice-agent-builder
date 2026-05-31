import { Body, Controller, Headers, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { env } from '../config/env';
import { TelephonyService } from './telephony.service';

@Public()
@Controller()
export class TelephonyWebhookController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('telephony/twilio/voice/:phoneNumberId')
  @HttpCode(200)
  async twilioVoice(
    @Param('phoneNumberId') phoneNumberId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ) {
    const twiml = await this.telephony.handleTwilioVoice(phoneNumberId, body, {
      headers,
      rawBody: req.rawBody?.toString('utf8'),
      url: externalRequestUrl(req),
    });
    res.type('text/xml').send(twiml);
  }

  @Post('telephony/twilio/status/:phoneNumberId')
  @HttpCode(200)
  twilioStatus(
    @Param('phoneNumberId') phoneNumberId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.telephony.handleStatusWebhook('twilio', phoneNumberId, body, {
      headers,
      rawBody: req.rawBody?.toString('utf8'),
      url: externalRequestUrl(req),
    });
  }

  @Post('telephony/twilio/fallback/:phoneNumberId')
  @HttpCode(200)
  twilioFallback(@Res() res: Response) {
    res
      .type('text/xml')
      .send('<Response><Say>Sorry, this voice agent is not available right now. Please try again later.</Say><Hangup/></Response>');
  }

  @Post('telephony/vobiz/inbound/:phoneNumberId')
  @HttpCode(200)
  vobizInbound(
    @Param('phoneNumberId') phoneNumberId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.telephony.handleStatusWebhook('vobiz', phoneNumberId, body, {
      headers,
      rawBody: req.rawBody?.toString('utf8'),
      url: externalRequestUrl(req),
    });
  }

  @Post('telephony/vobiz/status/:phoneNumberId')
  @HttpCode(200)
  vobizStatus(
    @Param('phoneNumberId') phoneNumberId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.telephony.handleStatusWebhook('vobiz', phoneNumberId, body, {
      headers,
      rawBody: req.rawBody?.toString('utf8'),
      url: externalRequestUrl(req),
    });
  }

  @Post('telephony/vobiz/verify/:phoneNumberId')
  @HttpCode(200)
  vobizVerify(
    @Param('phoneNumberId') phoneNumberId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.telephony.handleStatusWebhook('vobiz', phoneNumberId, body, {
      headers,
      rawBody: req.rawBody?.toString('utf8'),
      url: externalRequestUrl(req),
    });
  }

  @Post('livekit/webhooks')
  @HttpCode(200)
  livekitWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('authorization') authorization: string | undefined,
  ) {
    const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
    return this.telephony.handleLiveKitWebhook(rawBody, authorization);
  }
}

function externalRequestUrl(req: Request): string {
  return new URL(req.originalUrl ?? req.url, env.APP_BASE_URL ?? env.WEB_BASE_URL).toString();
}
