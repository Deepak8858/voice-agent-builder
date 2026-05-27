import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { XCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default function CheckoutCancelPage() {
  return (
    <div className="mx-auto flex min-h-[70dvh] max-w-2xl flex-col items-center justify-center px-6 py-16 text-center">
      <Card className="w-full overflow-hidden bg-card/95 shadow-sm">
        <CardContent className="flex flex-col items-center gap-4 p-10">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
            <XCircle className="h-7 w-7" />
          </div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
            Checkout cancelled
          </h1>
          <p className="text-sm text-muted-foreground">
            No worries — you haven&apos;t been charged. You can return to pricing to choose a different
            plan or head back to your dashboard.
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href="/pricing">Back to pricing</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/dashboard/billing">Open billing</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
