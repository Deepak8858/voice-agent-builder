'use client';

import { useQuery } from '@tanstack/react-query';
import type { InvoiceDto } from '@voiceforge/shared';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { Receipt, ExternalLink } from 'lucide-react';

interface InvoiceHistoryProps {
  workspaceId: string;
}

export function InvoiceHistory({ workspaceId }: InvoiceHistoryProps) {
  const { call } = useApi();

  const invoices = useQuery({
    queryKey: ['billing', 'invoices', workspaceId],
    queryFn: () => call<{ items: InvoiceDto[] }>(`/workspaces/${workspaceId}/billing/invoices`),
  });

  if (invoices.isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">Loading invoices...</p>
        </CardContent>
      </Card>
    );
  }

  const items = invoices.data?.items ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="h-4 w-4 text-primary" />
          Invoice History
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-3 text-left text-muted-foreground font-medium">Date</th>
                  <th className="pb-3 text-left text-muted-foreground font-medium">Period</th>
                  <th className="pb-3 text-right text-muted-foreground font-medium">Amount</th>
                  <th className="pb-3 text-right text-muted-foreground font-medium">Status</th>
                  <th className="pb-3 text-right text-muted-foreground font-medium">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {items.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/50">
                    <td className="py-3">{new Date(inv.created * 1000).toLocaleDateString()}</td>
                    <td className="py-3 text-muted-foreground">
                      {new Date(inv.periodStart * 1000).toLocaleDateString()}
                      {' – '}
                      {new Date(inv.periodEnd * 1000).toLocaleDateString()}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {(inv.amountPaid / 100).toFixed(2)} {inv.currency.toUpperCase()}
                    </td>
                    <td className="py-3 text-right">
                      <Badge variant={inv.status === 'paid' ? 'default' : 'secondary'}>
                        {inv.status ?? 'unknown'}
                      </Badge>
                    </td>
                    <td className="py-3 text-right">
                      {inv.invoicePdf && (
                        <a
                          href={inv.invoicePdf}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          PDF <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}