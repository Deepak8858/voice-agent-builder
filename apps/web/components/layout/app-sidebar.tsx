'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';

const nav = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/calls', label: 'Calls' },
  { href: '/dashboard/templates', label: 'Templates' },
  { href: '/dashboard/knowledge', label: 'Knowledge' },
  { href: '/dashboard/integrations', label: 'Integrations' },
  { href: '/dashboard/clients', label: 'Clients' },
  { href: '/dashboard/agency/agents', label: 'Client agents' },
  { href: '/dashboard/compliance', label: 'Compliance' },
  { href: '/dashboard/analytics', label: 'Analytics' },
  { href: '/dashboard/white-label', label: 'White label' },
  { href: '/dashboard/billing', label: 'Billing' },
  { href: '/dashboard/settings', label: 'Settings' },
];

interface AppSidebarProps {
  activeWorkspaceName?: string;
}

export function AppSidebar({ activeWorkspaceName }: AppSidebarProps = {}) {
  const pathname = usePathname();
  return (
    <aside className="hidden w-56 shrink-0 border-r border-zinc-200 bg-white px-3 py-4 dark:border-zinc-800 dark:bg-zinc-950 md:block">
      {activeWorkspaceName ? (
        <div className="mb-4">
          <WorkspaceSwitcher activeName={activeWorkspaceName} />
        </div>
      ) : null}
      <nav className="flex flex-col gap-1">
        {nav.map((item) => {
          const active =
            pathname === item.href || (item.href !== '/dashboard' && pathname?.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm',
                active
                  ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-900 dark:text-zinc-50'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
