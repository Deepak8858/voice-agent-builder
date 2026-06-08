import { describe, expect, it } from 'vitest';
import { CreateOutboundCampaignDtoSchema } from './campaign';

describe('CreateOutboundCampaignDtoSchema', () => {
  it('defaults campaign schedule limits for valid contacts', () => {
    const dto = CreateOutboundCampaignDtoSchema.parse({
      agent_id: '11111111-1111-1111-1111-111111111111',
      name: 'Consented Test Campaign',
      contacts: [{ phone: '+917607185834', full_name: 'Aditya' }],
    });

    expect(dto.schedule).toEqual({ max_calls_per_hour: 10, max_concurrent: 3 });
  });

  it('rejects non-E.164 campaign contact numbers', () => {
    expect(() =>
      CreateOutboundCampaignDtoSchema.parse({
        agent_id: '11111111-1111-1111-1111-111111111111',
        name: 'Invalid Campaign',
        contacts: [{ phone: '7607185834' }],
      }),
    ).toThrow();
  });
});
