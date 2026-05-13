'use client';

import { useState, useEffect } from 'react';
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
  tools: 'tools',
  workspaces: 'workspaces',
  contacts: 'contacts',
};

const PLAN_RECOMMENDATIONS: Record<string, { plan: string; label: string; reason: string }> = {
  free: {
    plan: 'starter',
    label: 'Starter — $49/mo',
    reason: 'Get 300 minutes/month and up to 5 agents.',
  },
  starter: {
    plan: 'growth',
    label: 'Growth — $149/mo',
    reason: 'Unlimited call campaigns and advanced compliance.',
  },
  growth: {
    plan: 'enterprise',
    label: 'Enterprise — $499/mo',
    reason: 'Unlimited everything with dedicated support.',
  },
};

export function UpgradeModal({
  open,
  onClose,
  limitType,
  currentPlan = 'free',
  onUpgrade,
}: UpgradeModalProps) {
  const recommendation = PLAN_RECOMMENDATIONS[currentPlan] ?? PLAN_RECOMMENDATIONS['free'];
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
                <DialogTitle>You&apos;ve hit your limit</DialogTitle>
                {limitLabel && (
                  <DialogDescription className="mt-0.5">
                    Upgrade to continue making {limitLabel}.
                  </DialogDescription>
                )}
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
            <p className="text-sm font-medium text-muted-foreground">What you get with {recommendation.plan}:</p>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {recommendation.plan === 'starter' && (
                <>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" /> 300 min/mo</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" /> 5 agents</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" /> White-label</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" /> API access</div>
                </>
              )}
              {recommendation.plan === 'growth' && (
                <>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Zap className="h-3.5 w-3.5 text-amber-500" /> 2,000 min/mo</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Zap className="h-3.5 w-3.5 text-amber-500" /> Unlimited campaigns</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Zap className="h-3.5 w-3.5 text-amber-500" /> Custom domain</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Zap className="h-3.5 w-3.5 text-amber-500" /> Advanced compliance</div>
                </>
              )}
              {recommendation.plan === 'enterprise' && (
                <>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="h-3.5 w-3.5 text-emerald-500" /> Unlimited all</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="h-3.5 w-3.5 text-emerald-500" /> Dedicated support</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="h-3.5 w-3.5 text-emerald-500" /> HIPAA-ready</div>
                  <div className="flex items-center gap-1.5 text-muted-foreground"><Building2 className="h-3.5 w-3.5 text-emerald-500" /> SSO / SAML</div>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Button onClick={onUpgrade} className="w-full gap-2">
            Upgrade to {recommendation.plan}
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