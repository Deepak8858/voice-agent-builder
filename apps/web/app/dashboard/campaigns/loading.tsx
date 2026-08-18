import { PageSkeleton } from '@/components/dashboard/page-skeleton';

export default function Loading() {
  return <PageSkeleton stats={4} body="list" withActions={true} />;
}