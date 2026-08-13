import { describe, expect, it } from 'vitest';
import {
  POSTHOG_PROXY_ARRAY_SOURCE,
  POSTHOG_PROXY_INGESTION_SOURCE,
  POSTHOG_PROXY_PREFIX,
  POSTHOG_PROXY_STATIC_SOURCE,
  assetHostFor,
  posthogInitOptions,
  posthogProxyRewrites,
  posthogSuperProperties,
  posthogWebSettingsFromEnv,
  resolvePostHogHost,
  uiHostFor,
} from './posthog-config';

const ENABLED_ENV = {
  NEXT_PUBLIC_POSTHOG_ENABLED: 'true',
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: 'phc_test_token',
  NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
};

function settings() {
  const resolved = posthogWebSettingsFromEnv(ENABLED_ENV);
  if (!resolved) throw new Error('expected settings to resolve');
  return resolved;
}

describe('posthogWebSettingsFromEnv', () => {
  it('is a no-op without a project token', () => {
    expect(
      posthogWebSettingsFromEnv({
        NEXT_PUBLIC_POSTHOG_ENABLED: 'true',
        NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: '',
      }),
    ).toBeNull();
    expect(
      posthogWebSettingsFromEnv({
        NEXT_PUBLIC_POSTHOG_ENABLED: 'true',
        NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: '   ',
      }),
    ).toBeNull();
    expect(posthogWebSettingsFromEnv({ NEXT_PUBLIC_POSTHOG_ENABLED: 'true' })).toBeNull();
  });

  it('is a no-op unless the kill switch is exactly "true"', () => {
    for (const flag of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(
        posthogWebSettingsFromEnv({
          ...ENABLED_ENV,
          NEXT_PUBLIC_POSTHOG_ENABLED: flag,
        }),
        `kill switch value ${String(flag)} must not enable analytics`,
      ).toBeNull();
    }
  });

  it('resolves region-matched hosts when enabled', () => {
    expect(settings()).toEqual({
      projectToken: 'phc_test_token',
      host: 'https://us.i.posthog.com',
      assetHost: 'https://us-assets.i.posthog.com',
      uiHost: 'https://us.posthog.com',
      environment: 'development',
      release: 'dev',
    });
  });

  it('falls back to the US host for a malformed or non-https host', () => {
    for (const host of ['not-a-url', 'http://evil.example', 'https://evil.example/path', '']) {
      const resolved = posthogWebSettingsFromEnv({ ...ENABLED_ENV, NEXT_PUBLIC_POSTHOG_HOST: host });
      expect(resolved?.host, `host ${host} must not be trusted`).toBe('https://us.i.posthog.com');
    }
  });

  it('carries release metadata but never user data', () => {
    const resolved = posthogWebSettingsFromEnv({
      ...ENABLED_ENV,
      NEXT_PUBLIC_APP_ENV: 'staging',
      NEXT_PUBLIC_APP_VERSION: 'abc1234',
    });

    expect(posthogSuperProperties(resolved!)).toEqual({
      environment: 'staging',
      release: 'abc1234',
    });
  });
});

describe('resolvePostHogHost', () => {
  const MALFORMED = [
    'not-a-url',
    'http://evil.example',
    'https://evil.example/path',
    'https://user:pass@evil.example',
    'https://us.i.posthog.com:8443',
    '//us.i.posthog.com',
  ];

  it('treats an unset host as the default region, not as a misconfiguration', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(resolvePostHogHost(raw, { strict: true })).toBe('https://us.i.posthog.com');
      expect(resolvePostHogHost(raw, { strict: false })).toBe('https://us.i.posthog.com');
    }
  });

  it('accepts an origin-only https host and strips trailing slashes', () => {
    expect(resolvePostHogHost('https://eu.i.posthog.com', { strict: true })).toBe(
      'https://eu.i.posthog.com',
    );
    expect(resolvePostHogHost('  https://eu.i.posthog.com///  ', { strict: true })).toBe(
      'https://eu.i.posthog.com',
    );
  });

  it('falls back rather than breaking the page when not strict', () => {
    for (const host of MALFORMED) {
      expect(resolvePostHogHost(host, { strict: false }), host).toBe(
        'https://us.i.posthog.com',
      );
    }
  });

  it('refuses to build a proxy against a malformed host when strict', () => {
    for (const host of MALFORMED) {
      expect(() => resolvePostHogHost(host, { strict: true }), host).toThrow(
        /origin-only https URL/,
      );
    }
  });

  it('names the offending variable so a failed build is actionable', () => {
    // Callers read different variables; an error that named only one of them
    // would send someone editing the wrong setting.
    expect(() =>
      resolvePostHogHost('not-a-url', {
        strict: true,
        envVar: 'NEXT_PUBLIC_POSTHOG_HOST',
      }),
    ).toThrow(/^NEXT_PUBLIC_POSTHOG_HOST must be/);
    expect(() =>
      resolvePostHogHost('not-a-url', { strict: true, envVar: 'POSTHOG_HOST' }),
    ).toThrow(/^POSTHOG_HOST must be/);
  });

  it('resolves the browser SDK and the proxy to the same host', () => {
    // Drift between these two silently 404s every capture, so they must be
    // derived from one function rather than two parsers that agree by accident.
    const raw = 'https://eu.i.posthog.com/';
    const browser = posthogWebSettingsFromEnv({
      ...ENABLED_ENV,
      NEXT_PUBLIC_POSTHOG_HOST: raw,
    });
    const proxy = resolvePostHogHost(raw, { strict: true });

    expect(browser?.host).toBe(proxy);
    expect(assetHostFor(proxy)).toBe(browser?.assetHost);
  });
});

describe('host derivation', () => {
  it('routes assets to the region assets host', () => {
    expect(assetHostFor('https://us.i.posthog.com')).toBe('https://us-assets.i.posthog.com');
    expect(assetHostFor('https://eu.i.posthog.com')).toBe('https://eu-assets.i.posthog.com');
  });

  it('leaves a self-hosted instance serving its own assets and UI', () => {
    expect(assetHostFor('https://ph.internal.example')).toBe('https://ph.internal.example');
    expect(uiHostFor('https://ph.internal.example')).toBe('https://ph.internal.example');
  });

  it('separates the app UI host from the ingestion host', () => {
    expect(uiHostFor('https://eu.i.posthog.com')).toBe('https://eu.posthog.com');
  });
});

describe('posthogProxyRewrites', () => {
  const rewrites = posthogProxyRewrites({
    host: 'https://eu.i.posthog.com',
    assetHost: 'https://eu-assets.i.posthog.com',
  });

  it('matches the asset routes before the ingestion catch-all', () => {
    const sources = rewrites.map((r) => r.source);

    expect(sources).toEqual([
      POSTHOG_PROXY_STATIC_SOURCE,
      POSTHOG_PROXY_ARRAY_SOURCE,
      POSTHOG_PROXY_INGESTION_SOURCE,
    ]);
    expect(sources.indexOf(POSTHOG_PROXY_STATIC_SOURCE)).toBeLessThan(
      sources.indexOf(POSTHOG_PROXY_INGESTION_SOURCE),
    );
    expect(sources.indexOf(POSTHOG_PROXY_ARRAY_SOURCE)).toBeLessThan(
      sources.indexOf(POSTHOG_PROXY_INGESTION_SOURCE),
    );
  });

  it('sends lazily-loaded bundles and remote config to the assets host', () => {
    expect(rewrites[0]).toEqual({
      source: `${POSTHOG_PROXY_PREFIX}/static/:path*`,
      destination: 'https://eu-assets.i.posthog.com/static/:path*',
    });
    expect(rewrites[1]).toEqual({
      source: `${POSTHOG_PROXY_PREFIX}/array/:path*`,
      destination: 'https://eu-assets.i.posthog.com/array/:path*',
    });
  });

  it('sends capture, flags and replay to the ingestion host', () => {
    expect(rewrites[2]).toEqual({
      source: `${POSTHOG_PROXY_PREFIX}/:path*`,
      destination: 'https://eu.i.posthog.com/:path*',
    });
  });

  it('keeps every source on the same origin under one prefix', () => {
    for (const { source } of rewrites) {
      expect(source.startsWith(`${POSTHOG_PROXY_PREFIX}/`)).toBe(true);
    }
  });

  it('uses a prefix that does not advertise itself as analytics', () => {
    for (const blocked of ['ingest', 'posthog', 'analytics', 'telemetry', 'track']) {
      expect(POSTHOG_PROXY_PREFIX).not.toContain(blocked);
    }
  });
});

describe('posthogInitOptions', () => {
  const options = posthogInitOptions(settings());

  it('sends browser traffic to the same-origin proxy, never to PostHog directly', () => {
    expect(options.api_host).toBe(POSTHOG_PROXY_PREFIX);
    expect(options.api_host?.startsWith('http')).toBe(false);
  });

  it('points the UI host at the PostHog app, not at ingestion', () => {
    expect(options.ui_host).toBe('https://us.posthog.com');
  });

  it('disables every capture path that reads page content', () => {
    expect(options.autocapture).toBe(false);
    expect(options.rageclick).toBe(false);
    expect(options.capture_heatmaps).toBe(false);
    expect(options.capture_dead_clicks).toBe(false);
    expect(options.capture_exceptions).toBe(false);
  });

  it('only profiles identified users', () => {
    expect(options.person_profiles).toBe('identified_only');
  });

  it('strips URL fragments and drops URL properties', () => {
    expect(options.disable_capture_url_hashes).toBe(true);
    expect(options.property_denylist).toContain('$current_url');
    expect(options.property_denylist).toContain('$referrer');
  });

  it('keeps session replay off', () => {
    expect(options.disable_session_recording).toBe(true);
  });

  it('pre-configures replay masking so enabling it cannot leak content', () => {
    expect(options.session_recording).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: '*',
      maskAllElementAttributes: true,
      blockClass: 'ph-no-capture',
      recordHeaders: false,
      recordBody: false,
      collectFonts: false,
    });
    expect(options.session_recording?.captureCanvas?.recordCanvas).toBe(false);
    expect(options.enable_recording_console_log).toBe(false);
  });

  it('masks text and element attributes globally', () => {
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
    expect(options.mask_personal_data_properties).toBe(true);
  });

  it('pins a defaults date so an SDK upgrade cannot change capture behaviour', () => {
    expect(options.defaults).toBe('2026-06-25');
  });

  it('does not enable surveys or product tours', () => {
    expect(options.disable_surveys).toBe(true);
    expect(options.disable_product_tours).toBe(true);
  });
});
