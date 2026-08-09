import type { ConfigDefaults, PostHogConfig } from 'posthog-js';

/**
 * Browser-side PostHog configuration.
 *
 * This module is deliberately free of side effects and of any `posthog-js`
 * runtime import so it can be unit tested under the repo's `node` Vitest
 * environment, and so `next.config.ts` can reuse the same proxy constants that
 * the browser SDK is pointed at. Drift between the two is the documented
 * failure mode of a first-party proxy, so both sides read from here.
 */

/**
 * Same-origin prefix that all PostHog traffic is proxied through.
 *
 * Deliberately not `/ingest`, `/posthog`, `/analytics` or any other name that
 * appears in public blocklists: the point of a first-party proxy is that it is
 * indistinguishable from the app's own routes. Anything under this prefix is
 * excluded from `middleware.ts` and must stay excluded.
 */
export const POSTHOG_PROXY_PREFIX = '/vf-relay';

/** Ingestion/flags traffic: `/e/`, `/i/v0/e/`, `/flags`, `/s/` (replay). */
export const POSTHOG_PROXY_INGESTION_SOURCE = `${POSTHOG_PROXY_PREFIX}/:path*`;
/** Lazily-loaded SDK bundles (`/static/<name>.js`). */
export const POSTHOG_PROXY_STATIC_SOURCE = `${POSTHOG_PROXY_PREFIX}/static/:path*`;
/** Remote config (`/array/<token>/config.js`), served from the assets host. */
export const POSTHOG_PROXY_ARRAY_SOURCE = `${POSTHOG_PROXY_PREFIX}/array/:path*`;

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * PostHog defaults bundle. Pinned to an explicit date rather than left unset so
 * an SDK upgrade can never silently switch on new capture behaviour; changing
 * it is a reviewed decision. `'2026-06-25'` also strips URL fragments from
 * captured URLs, which this product needs because fragments can carry IDs.
 */
const POSTHOG_DEFAULTS: ConfigDefaults = '2026-06-25';

export interface PostHogWebEnv {
  NEXT_PUBLIC_POSTHOG_ENABLED?: string | undefined;
  NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?: string | undefined;
  NEXT_PUBLIC_POSTHOG_HOST?: string | undefined;
  NEXT_PUBLIC_APP_ENV?: string | undefined;
  NEXT_PUBLIC_APP_VERSION?: string | undefined;
  NODE_ENV?: string | undefined;
}

export interface PostHogWebSettings {
  projectToken: string;
  /** Real PostHog ingestion host; used only to derive proxy destinations. */
  host: string;
  /** Assets host for lazily-loaded bundles and remote config. */
  assetHost: string;
  /** PostHog app host, used for toolbar/"view in PostHog" links only. */
  uiHost: string;
  environment: string;
  release: string;
}

/** Origin-only HTTPS URL: no path, no port, no query, no credentials. */
const POSTHOG_HOST_SHAPE = /^https:\/\/[a-z0-9.-]+$/i;

/**
 * Single source of truth for interpreting a configured PostHog host.
 *
 * Three callers resolve the host through here: the browser SDK settings, the
 * `next.config.ts` proxy destinations (both reading `NEXT_PUBLIC_POSTHOG_HOST`)
 * and the server-side emitter in `posthog-server.ts` (reading `POSTHOG_HOST`).
 * The first two must agree exactly: the browser posts to a same-origin path and
 * the rewrite decides where that lands, so a difference of one character
 * between them means every capture 404s at runtime with no client-side error.
 *
 * An unset host is the normal state and resolves to the default region. A host
 * that is set but malformed is a misconfiguration, and `strict` decides how
 * loudly it fails:
 *  - `strict: false` (browser, server emitter) falls back, because analytics
 *    must never break a page load or a request.
 *  - `strict: true` (production build) throws, because shipping a build whose
 *    proxy silently points at the wrong region is worse than a failed build.
 *
 * `envVar` names the variable the value was read from. Callers read different
 * variables, and a build-breaking error is only actionable if it says which one
 * to fix.
 */
export function resolvePostHogHost(
  raw: string | undefined,
  options: { strict: boolean; envVar?: string },
): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_POSTHOG_HOST;
  if (POSTHOG_HOST_SHAPE.test(trimmed)) return trimmed;
  if (options.strict) {
    throw new Error(
      `${options.envVar ?? 'The PostHog host'} must be an origin-only https URL ` +
        '(for example https://eu.i.posthog.com); refusing to build a proxy ' +
        'against a malformed host.',
    );
  }
  return DEFAULT_POSTHOG_HOST;
}

/**
 * `https://us.i.posthog.com` -> `https://us-assets.i.posthog.com`.
 * Mirrors `RequestRouter.endpointFor('assets', …)` in posthog-js, which routes
 * `/static/` and `/array/` to a `<region>-assets` host. A self-hosted or
 * otherwise unrecognised host serves its own assets, so it is returned as-is.
 */
export function assetHostFor(host: string): string {
  const match = /^https:\/\/(us|eu)\.i\.posthog\.com$/i.exec(host);
  return match ? `https://${match[1]!.toLowerCase()}-assets.i.posthog.com` : host;
}

/** `https://us.i.posthog.com` -> `https://us.posthog.com` (app UI, not ingestion). */
export function uiHostFor(host: string): string {
  const match = /^https:\/\/(us|eu)\.i\.posthog\.com$/i.exec(host);
  return match ? `https://${match[1]!.toLowerCase()}.posthog.com` : host;
}

/**
 * Resolves browser settings, or `null` when analytics must stay a no-op.
 *
 * Two independent conditions must both hold: the kill switch is on and a
 * project token is present. A missing token is the normal state for local
 * development and for any deployment that has not completed Phase 0 governance,
 * so it is not an error.
 */
export function posthogWebSettingsFromEnv(env: PostHogWebEnv): PostHogWebSettings | null {
  if (env.NEXT_PUBLIC_POSTHOG_ENABLED !== 'true') return null;

  const projectToken = env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  if (!projectToken) return null;

  // Never strict: a bad host must degrade analytics, not the dashboard.
  const host = resolvePostHogHost(env.NEXT_PUBLIC_POSTHOG_HOST, {
    strict: false,
    envVar: 'NEXT_PUBLIC_POSTHOG_HOST',
  });

  return {
    projectToken,
    host,
    assetHost: assetHostFor(host),
    uiHost: uiHostFor(host),
    environment: env.NEXT_PUBLIC_APP_ENV?.trim() || env.NODE_ENV || 'development',
    release: env.NEXT_PUBLIC_APP_VERSION?.trim() || 'dev',
  };
}

/**
 * Rewrite rules for `next.config.ts`, most specific first.
 *
 * Order matters: `/static/` and `/array/` must be matched before the catch-all,
 * otherwise SDK bundles and remote config are sent to the ingestion host and
 * 404. They are returned as `beforeFiles` rewrites so they cannot be shadowed
 * by a same-named app route.
 */
export function posthogProxyRewrites(
  settings: Pick<PostHogWebSettings, 'host' | 'assetHost'>,
): Array<{ source: string; destination: string }> {
  return [
    {
      source: POSTHOG_PROXY_STATIC_SOURCE,
      destination: `${settings.assetHost}/static/:path*`,
    },
    {
      source: POSTHOG_PROXY_ARRAY_SOURCE,
      destination: `${settings.assetHost}/array/:path*`,
    },
    {
      source: POSTHOG_PROXY_INGESTION_SOURCE,
      destination: `${settings.host}/:path*`,
    },
  ];
}

/**
 * Init options for `posthog.init(token, …)`.
 *
 * Everything that could carry customer data is off. In particular:
 *  - `autocapture: false` — autocaptured DOM events carry element text, and
 *    this UI renders transcripts, caller names and phone numbers.
 *  - `capture_pageview: 'history_change'` with `disable_capture_url_hashes`
 *    (implied by the pinned defaults) — route IDs are opaque UUIDs, but
 *    fragments and query strings are not trusted.
 *  - `disable_session_recording: true` — replay stays off until the consent and
 *    retention policy from Phase 0 is settled. The masking options below are
 *    still declared so that enabling replay is a one-line, already-safe change
 *    rather than a fresh privacy review.
 *  - `capture_exceptions: false` — error tracking is a separate guarded
 *    rollout; exception messages and stacks can embed customer values.
 */
export function posthogInitOptions(settings: PostHogWebSettings): Partial<PostHogConfig> {
  return {
    // Same-origin first-party proxy. Relative on purpose: it keeps every
    // request under `connect-src 'self'` and inherits the app's own origin.
    api_host: POSTHOG_PROXY_PREFIX,
    ui_host: settings.uiHost,
    defaults: POSTHOG_DEFAULTS,

    // Anonymous visitors never get a person profile; only an explicit
    // `identify()` from the authenticated dashboard creates one.
    person_profiles: 'identified_only',

    autocapture: false,
    rageclick: false,
    capture_pageview: 'history_change',
    capture_pageleave: 'if_capture_pageview',
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_performance: false,
    capture_exceptions: false,
    disable_capture_url_hashes: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_external_dependency_loading: false,

    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    property_denylist: ['$current_url', '$referrer', '$initial_current_url', '$initial_referrer'],

    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      maskAllElementAttributes: true,
      blockClass: 'ph-no-capture',
      maskTextClass: 'ph-mask',
      collectFonts: false,
      recordHeaders: false,
      recordBody: false,
      captureCanvas: { recordCanvas: false },
    },
    enable_recording_console_log: false,
  };
}

/** Super properties registered on every event. Release metadata only. */
export function posthogSuperProperties(
  settings: Pick<PostHogWebSettings, 'environment' | 'release'>,
): Record<string, string> {
  return { environment: settings.environment, release: settings.release };
}
