export interface PlanLimitRedirect {
  message: string;
  limitType?: string;
  currentPlan?: string;
  upgradePath: string;
}

const DEFAULT_UPGRADE_PATH = '/dashboard/billing';

export function getPlanLimitRedirect(err: unknown): PlanLimitRedirect | null {
  if (!err || typeof err !== 'object') return null;

  const record = err as Record<string, unknown>;
  if (record['code'] !== 'LIMIT_EXCEEDED') return null;

  return {
    message: err instanceof Error ? err.message : 'Upgrade your plan to continue.',
    limitType: typeof record['limitType'] === 'string' ? record['limitType'] : undefined,
    currentPlan: typeof record['currentPlan'] === 'string' ? record['currentPlan'] : undefined,
    upgradePath: safeRelativePath(record['upgradePath']),
  };
}

function safeRelativePath(value: unknown): string {
  if (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
  ) {
    return value;
  }
  return DEFAULT_UPGRADE_PATH;
}
