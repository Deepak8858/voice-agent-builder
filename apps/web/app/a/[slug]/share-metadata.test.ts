import { describe, expect, it } from 'vitest';
import { sharePageMetadata } from './share-metadata';
import { siteUrl } from '@/lib/site-url';

/**
 * Public agent share pages (`/a/:slug`) are crawlable by design — they are the
 * marketing surface prospects are sent to. They shipped with only a title and
 * description: no canonical URL and no OpenGraph/Twitter image, so shared links
 * rendered as bare text and near-duplicate agents had no canonical signal.
 */
describe('sharePageMetadata', () => {
  const agent = {
    name: 'Smile Dental Receptionist',
    workspaceName: 'Smile Dental',
    businessName: 'Smile Dental',
  };

  it('sets a self-referencing canonical on the share URL', () => {
    const meta = sharePageMetadata('smile-dental', agent);

    expect(meta.alternates?.canonical).toBe('/a/smile-dental');
  });

  it('builds a descriptive title and description from the agent', () => {
    const meta = sharePageMetadata('smile-dental', agent);

    expect(meta.title).toContain('Smile Dental Receptionist');
    expect(String(meta.description)).toContain('Smile Dental');
  });

  it('supplies an OpenGraph image and a large Twitter card', () => {
    const meta = sharePageMetadata('smile-dental', agent);

    expect(meta.openGraph?.images).toBeDefined();
    // Next's `Twitter` metadata type is a union; only the card-bearing variants
    // expose `card`, so narrow before asserting on it.
    const twitter = meta.twitter;
    expect(twitter).toBeDefined();
    expect(twitter && 'card' in twitter ? twitter.card : undefined).toBe('summary_large_image');
  });

  it('points OpenGraph at the absolute share URL', () => {
    const meta = sharePageMetadata('smile-dental', agent);

    expect(meta.openGraph?.url).toBe(`${siteUrl}/a/smile-dental`);
  });

  it('falls back to neutral copy when the business name is missing', () => {
    const meta = sharePageMetadata('demo-agent', {
      name: 'Demo Agent',
      workspaceName: 'Demo Workspace',
      businessName: undefined,
    });

    expect(String(meta.description).length).toBeGreaterThan(0);
    expect(String(meta.description)).not.toContain('undefined');
  });

  it('marks a missing agent noindex so 404-ish pages do not enter the index', () => {
    const meta = sharePageMetadata('gone', null);

    expect(meta.robots).toStrictEqual({ index: false, follow: false });
  });
});
