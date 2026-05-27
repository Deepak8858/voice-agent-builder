import Link from 'next/link';
import { Bot, MessageSquareText } from 'lucide-react';

type CreationMode = 'spec' | 'chat';

const modes = [
  {
    id: 'spec' as const,
    href: '/dashboard/agents/new',
    label: 'Spec builder',
    Icon: Bot,
  },
  {
    id: 'chat' as const,
    href: '/dashboard/agents/new/ai-generate',
    label: 'Chat to voice agent',
    Icon: MessageSquareText,
  },
];

export function AgentCreationModeTabs({ active }: { active: CreationMode }) {
  return (
    <div className="inline-flex w-fit max-w-full items-center gap-1 rounded-lg border border-border bg-muted p-1">
      {modes.map(({ id, href, label, Icon }) => {
        const selected = active === id;
        return (
          <Link
            key={id}
            href={href}
            aria-current={selected ? 'page' : undefined}
            className={`inline-flex min-h-9 items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">{label}</span>
          </Link>
        );
      })}
    </div>
  );
}
