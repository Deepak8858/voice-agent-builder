'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  getPlanById,
  getPlanEntitlements,
  type PlanType,
} from '@voiceforge/shared';
import { TrendingUp, X, Sparkles, Zap, Building2 } from 'lucide-react';

interface UpgradeModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Called when user closes the modal */
  onClose: () => void;
  /** The limit that was hit (e.g., 'calls', 'minutes', 'agents') */
  limitType?: string;
  /** Current plan of the user */
  currentPlan?: string;
  /** Called when user clicks upgrade */
  onUpgrade?: () => void;
}

const LIMIT_LABELS: Record<string, string> = {
  calls: 'outbound calls',
  minutes: 'voice minutes',
  agents: 'agents',
  tools: 'integration connections',
  workspaces: 'workspaces',
  contacts: 'contacts',
};

const NEXT_PLAN: Record<string, PlanType> = {
  free: 'starter',
  starter: 'growth',
  growth: 'enterprise',
};

/**
 * Recommendation copy is derived from the shared catalog so the modal can
 * never drift away from the prices and quotas that billing enforces.
 */
function buildRecommendation(currentPlan: string): {
  plan: PlanType;
  label: string;
  reason: string;
} {
  const target = NEXT_PLAN[currentPlan] ?? 'starter';
  const entry = getPlanById(target);
  const entitlements = getPlanEntitlements(target);
  const priceLabel = entry?.priceLabel ?? '';
  const label =
    target === 'enterprise'
      ? `${entry?.name ?? 'Enterprise'} — sales-assisted`
      : `${entry?.name ?? target} — ${priceLabel}/mo`;
  const reason =
    target === 'enterprise'
      ? `Contracted capacity up to ${entitlements.maximumContractConcurrentCalls} concurrent calls and ${entitlements.includedMinutes.toLocaleString('en-US')} included minutes.`
      : `${entitlements.includedMinutes.toLocaleString('en-US')} included minutes per month, ${entitlements.agents} agents, and ${entitlements.concurrentCalls} concurrent calls.`;
  return { plan: target, label, reason };
}

function PlanIcon({ plan }: { plan: PlanType }) {
  if (plan === 'growth') return <Zap className="h-3.5 w-3.5 text-amber-500" />;
  if (plan === 'enterprise') return <Building2 className="h-3.5 w-3.5 text-emerald-500" />;
  return <Sparkles className="h-3.5 w-3.5 text-primary" />;
}

export function UpgradeModal({
  open,
  onClose,
  limitType,
  currentPlan = 'free',
  onUpgrade,
}: UpgradeModalProps) {
  const recommendation = buildRecommendation(currentPlan);
  const recommendedEntitlements = getPlanEntitlements(recommendation.plan);
  const limitLabel = limitType ? LIMIT_LABELS[limitType] ?? limitType : null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-chart-2/20">
                <TrendingUp className="h-5 w-5 text-chart-2" />
              </div>
              <div>
                <DialogTitle>You&apos;ve hit your plan limit</DialogTitle>
                {limitLabel ? (
                  <DialogDescription className="mt-0.5">
                    Your organization has used its {limitLabel} allowance on this plan.
                  </DialogDescription>
                ) : null}
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="shrink-0">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* Recommended plan */}
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                {recommendation.plan === 'starter' && <Sparkles className="h-5 w-5 text-primary mt-0.5" />}
                {recommendation.plan === 'growth' && <Zap className="h-5 w-5 text-amber-500 mt-0.5" />}
                {recommendation.plan === 'enterprise' && <Building2 className="h-5 w-5 text-emerald-500 mt-0.5" />}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{recommendation.label}</span>
                    <Badge variant="outline" className="text-xs">Recommended</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {recommendation.reason}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* What's included */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">
              What you get with {recommendation.plan}:
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {[
                `${recommendedEntitlements.includedMinutes.toLocaleString('en-US')} min/mo`,
                `${recommendedEntitlements.agents} agents`,
                `${recommendedEntitlements.concurrentCalls} concurrent calls`,
                `${recommendedEntitlements.nangoConnections} integrations`,
                `${recommendedEntitlements.workspaces} workspaces`,
                `${recommendedEntitlements.contacts.toLocaleString('en-US')} contacts`,
              ].map((item) => (
                <div key={item} className="flex items-center gap-1.5 text-muted-foreground">
                  <PlanIcon plan={recommendation.plan} />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Button onClick={onUpgrade} className="w-full gap-2">
            {recommendation.plan === 'enterprise'
              ? 'Talk to sales'
              : `Upgrade to ${recommendation.plan}`}
            <TrendingUp className="h-4 w-4" />
          </Button>
          <Button variant="ghost" onClick={onClose} className="w-full">
            Maybe later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Hook for using the upgrade modal with API error handling
export function useUpgradeModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [limitType, setLimitType] = useState<string | undefined>(undefined);

  const openForLimit = (type: string) => {
    setLimitType(type);
    setIsOpen(true);
  };

  const close = () => setIsOpen(false);

  return { isOpen, limitType, openForLimit, close };
}
