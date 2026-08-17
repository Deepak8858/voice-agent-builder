'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * `RichTextEditor` pulls in tiptap and ProseMirror, which is one of the
 * heaviest client bundles in the app. Most visits to a page that contains an
 * editor never type into it — the editor is often behind a tab, a source-type
 * selector, or below the fold — so it is loaded on demand instead of shipping
 * with the route's first-load JS.
 *
 * `ssr: false` because the editor is inherently client-only (it constructs a
 * ProseMirror view against the DOM); rendering it on the server buys nothing
 * and would only be discarded on hydration.
 */
export const LazyRichTextEditor = dynamic(
  () => import('@/components/ui/rich-text-editor').then((m) => m.RichTextEditor),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[150px] w-full rounded-md" />,
  },
);
