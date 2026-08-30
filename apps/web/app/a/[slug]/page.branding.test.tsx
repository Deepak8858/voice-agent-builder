import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentSharePage from './page';

/**
 * A-016: `hidePlatformBranding` is stored, validated and served by the API, and
 * it is the thing the Growth plan actually sells, but this page parsed it and
 * then ignored it — so a paying white-label tenant's share page still carried
 * the platform's sign-up and pricing promotion.
 *
 * The page is an async server component with no client state, so it is rendered
 * directly: awaiting it yields the element tree, and renderToStaticMarkup gives
 * the HTML a visitor would receive.
 */
const AGENT_ID = '11111111-2222-3333-4444-555555555555';

function sharePayload(hidePlatformBranding: boolean | null) {
  return {
    success: true,
    data: {
      found: true,
      id: AGENT_ID,
      name: 'Dental Receptionist',
      shareSlug: `dental-receptionist-${AGENT_ID}`,
      demoAudioUrl: null,
      sampleTranscript: [],
      workspaceName: 'Smile Dental',
      organizationName: 'Smile Dental Group',
      branding:
        hidePlatformBranding === null
          ? null
          : {
              brandName: 'Smile Dental',
              logoUrl: null,
              primaryColor: null,
              hidePlatformBranding,
            },
    },
  };
}

async function renderShare(hidePlatformBranding: boolean | null): Promise<string> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(sharePayload(hidePlatformBranding)))),
  );
  const element = await AgentSharePage({ params: Promise.resolve({ slug: `x-${AGENT_ID}` }) });
  return renderToStaticMarkup(element);
}

describe('agent share page honours hidePlatformBranding', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'http://api.test/api/v1';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the platform promotion when the flag is off', async () => {
    const html = await renderShare(false);

    expect(html).toContain('/sign-up?ref=');
    expect(html).toContain('Build your own voice agent');
    expect(html).toContain('/pricing');
    expect(html).toContain('href="/"');
    // The tenant's own content is present either way.
    expect(html).toContain('Smile Dental');
  });

  it('drops every platform call to action when the flag is on', async () => {
    const html = await renderShare(true);

    expect(html).not.toContain('/sign-up');
    expect(html).not.toContain('Build your own');
    expect(html).not.toContain('/pricing');
    expect(html).not.toContain('Free to start');
    // No link back to the platform home either.
    expect(html).not.toContain('href="/"');
    expect(html).toContain('Smile Dental');
  });

  it('keeps the promotion when the plan no longer entitles branding at all', async () => {
    // The API sends `branding: null` once white-label is not entitled, which must
    // read as "show platform branding", not as a missing flag that hides it.
    const html = await renderShare(null);

    expect(html).toContain('/sign-up?ref=');
    expect(html).toContain('/pricing');
  });
});
