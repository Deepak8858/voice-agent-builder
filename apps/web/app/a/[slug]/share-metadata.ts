import type { Metadata } from 'next';
import { siteUrl } from '@/lib/site-url';

const shareImage = '/images/voiceforge-builder-preview.png';

export interface ShareAgentSummary {
  name: string;
  workspaceName: string;
  businessName?: string;
}

/**
 * Metadata for a public agent share page.
 *
 * These pages are the crawlable marketing surface, so each needs a
 * self-referencing canonical (many agents render near-identical layouts) and an
 * OG image so a shared link previews as a card rather than bare text.
 *
 * A missing agent is returned as `noindex`: the route still responds, and
 * without this an unpublished or deleted slug could be indexed as a dead page.
 */
export function sharePageMetadata(
  slug: string,
  agent: ShareAgentSummary | null,
): Metadata {
  const path = `/a/${slug}`;

  if (!agent) {
    return {
      title: 'Agent Not Found | VoiceForge AI',
      robots: { index: false, follow: false },
      alternates: { canonical: path },
    };
  }

  const business = agent.businessName ?? agent.workspaceName;
  const title = `${agent.name} — AI Voice Agent by ${agent.workspaceName}`;
  const description = `Hear ${agent.name}, an AI voice agent built for ${business} with VoiceForge AI. Play the sample call, read the transcript, and see the outcome signals.`;

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      title,
      description,
      url: `${siteUrl}${path}`,
      siteName: 'VoiceForge AI',
      images: [
        {
          url: shareImage,
          width: 1043,
          height: 552,
          alt: `${agent.name} voice agent on VoiceForge AI`,
        },
      ],
    },
    twitter: { card: 'summary_large_image', title, description, images: [shareImage] },
  };
}
