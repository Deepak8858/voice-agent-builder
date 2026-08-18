import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/**
 * Shared dashboard skeletons.
 *
 * Every dashboard route renders on the server and blocks on API round trips.
 * These primitives are what `loading.tsx` and `<Suspense>` fallbacks paint in
 * the meantime, so a navigation shows the page's real shape immediately
 * instead of a dead screen. They mirror the layout of the real components
 * (`PageHeader`, `StatCard`, list rows) so the swap-in is not a jump.
 */

export function PageHeaderSkeleton({ withActions = true }: { withActions?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border border-border/80 bg-card/85 p-5 shadow-sm shadow-stone-950/5 backdrop-blur sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <Skeleton className="h-3 w-32 rounded-full" />
          <Skeleton className="mt-4 h-9 w-full max-w-xl" />
          <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
          <Skeleton className="mt-2 h-4 w-2/3 max-w-md" />
        </div>
        {withActions ? (
          <div className="flex shrink-0 items-center gap-2">
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-40 rounded-md" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <Card key={index} className="overflow-hidden bg-card/90 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <Skeleton className="h-3 w-24 rounded-full" />
                <Skeleton className="mt-3 h-8 w-16" />
              </div>
              <Skeleton className="h-10 w-10 shrink-0 rounded-2xl" />
            </div>
            <Skeleton className="mt-4 h-3.5 w-4/5" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <Card className={cn('bg-card/90', className)}>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-3.5 w-72 max-w-full" />
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/70">
          {Array.from({ length: rows }).map((_, index) => (
            <li key={index} className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-4 w-1/3 min-w-[8rem]" />
                <Skeleton className="mt-2 h-3 w-1/2 min-w-[10rem]" />
              </div>
              <Skeleton className="h-6 w-20 shrink-0 rounded-full" />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function CardGridSkeleton({
  cards = 6,
  className,
}: {
  cards?: number;
  className?: string;
}) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3', className)}>
      {Array.from({ length: cards }).map((_, index) => (
        <Card key={index} className="overflow-hidden bg-card/95 shadow-sm">
          <CardHeader className="border-b border-border/70 bg-muted/25 pb-3">
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-20 shrink-0 rounded-full" />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 p-5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="mt-2 h-8 w-32 rounded-md" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function PanelSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn('bg-card/90', className)}>
      <CardHeader>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="mt-2 h-3.5 w-80 max-w-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-9 w-36 rounded-md" />
      </CardContent>
    </Card>
  );
}

export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <Card className="bg-card/90">
      <CardHeader>
        <Skeleton className="h-5 w-52" />
      </CardHeader>
      <CardContent>
        <Skeleton className="w-full rounded-lg" style={{ height }} />
      </CardContent>
    </Card>
  );
}

interface PageSkeletonProps {
  /** Number of stat cards to mimic. `0` hides the stat row entirely. */
  stats?: number;
  /** Body shape below the header/stat row. */
  body?: 'list' | 'cards' | 'panel' | 'charts' | 'none';
  withActions?: boolean;
}

/**
 * Whole-page fallback: header + optional stat row + a body shape.
 * Used directly by most `loading.tsx` files.
 */
export function PageSkeleton({
  stats = 4,
  body = 'list',
  withActions = true,
}: PageSkeletonProps) {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-live="polite">
      <PageHeaderSkeleton withActions={withActions} />
      {stats > 0 ? <StatGridSkeleton count={stats} /> : null}
      {body === 'list' ? <ListSkeleton /> : null}
      {body === 'cards' ? <CardGridSkeleton /> : null}
      {body === 'panel' ? <PanelSkeleton /> : null}
      {body === 'charts' ? (
        <div className="flex flex-col gap-6">
          <ChartSkeleton />
          <ChartSkeleton height={260} />
        </div>
      ) : null}
    </div>
  );
}
