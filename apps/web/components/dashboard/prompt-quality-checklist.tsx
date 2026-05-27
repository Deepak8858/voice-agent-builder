import { CheckCircle2, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';

interface PromptQualityChecklistProps {
  prompt: string;
  className?: string;
}

const checks = [
  {
    label: 'Clear call goal',
    test: (prompt: string) => /(goal|book|qualify|schedule|answer|support|sell|collect|follow up|confirm)/i.test(prompt),
  },
  {
    label: 'Business context',
    test: (prompt: string) => /(business|clinic|agency|company|customer|lead|patient|client|service|hours|pricing)/i.test(prompt),
  },
  {
    label: 'Phone-friendly tone',
    test: (prompt: string) => /(friendly|natural|concise|short|professional|warm|clear|phone)/i.test(prompt),
  },
  {
    label: 'Fallback or escalation',
    test: (prompt: string) => /(human|transfer|escalate|unsure|fallback|do not know|don't know)/i.test(prompt),
  },
  {
    label: 'Opening message or next step',
    test: (prompt: string) => /(first message|opening|start|greet|hello|ask|next step)/i.test(prompt),
  },
];

export function PromptQualityChecklist({ prompt, className }: PromptQualityChecklistProps) {
  const completed = checks.filter((check) => check.test(prompt)).length;
  return (
    <div className={cn('rounded-2xl border border-border bg-background/80 p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Prompt quality</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Voice agents work best with short, explicit goals and fallback rules.
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
          {completed}/{checks.length}
        </span>
      </div>
      <ul className="mt-3 space-y-2">
        {checks.map((check) => {
          const done = check.test(prompt);
          return (
            <li key={check.label} className="flex items-center gap-2 text-sm">
              {done ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground/45" />
              )}
              <span className={done ? 'text-foreground' : 'text-muted-foreground'}>{check.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
