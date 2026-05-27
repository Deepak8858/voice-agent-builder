'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Logo } from '@/components/logo';
import {
  LayoutDashboard,
  Bot,
  Phone,
  FileStack,
  BookOpen,
  Plug,
  Users,
  ShieldCheck,
  BarChart3,
  Palette,
  CreditCard,
  Settings,
  Menu,
  Plus,
  Sparkles,
} from 'lucide-react';

const navSections = [
  {
    label: 'Build',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/dashboard/agents', label: 'Voice Agents', icon: Bot },
      { href: '/dashboard/agents/new', label: 'Create Agent', icon: Plus },
      { href: '/dashboard/templates', label: 'Templates', icon: FileStack },
    ],
  },
  {
    label: 'Operate',
    items: [
      { href: '/dashboard/calls', label: 'Call Logs', icon: Phone },
      { href: '/dashboard/campaigns', label: 'Campaigns', icon: Sparkles },
      { href: '/dashboard/knowledge', label: 'Knowledge Base', icon: BookOpen },
      { href: '/dashboard/integrations', label: 'Integrations', icon: Plug },
      { href: '/dashboard/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    label: 'Manage',
    items: [
      { href: '/dashboard/clients', label: 'Clients', icon: Users },
      { href: '/dashboard/compliance', label: 'Compliance', icon: ShieldCheck },
      { href: '/dashboard/white-label', label: 'White label', icon: Palette },
      { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function AppSidebar() {
  return (
    <>
      <MobileDashboardNav />
      <aside className="hidden w-72 shrink-0 border-r border-sidebar-border/80 bg-sidebar/95 px-4 py-5 shadow-sm shadow-stone-950/5 md:flex md:min-h-dvh md:flex-col md:gap-6">
        <SidebarBrand />
        <NavSections />
        <div className="mt-auto rounded-2xl border border-sidebar-border bg-gradient-to-br from-primary/10 via-sidebar to-sky-500/10 p-4">
          <p className="text-sm font-semibold text-sidebar-foreground">Ready to test?</p>
          <p className="mt-1 text-xs leading-5 text-sidebar-foreground/65">
            Create an agent, add clear instructions, then run a browser test call before publishing.
          </p>
          <Button asChild size="sm" className="mt-3 w-full">
            <Link href="/dashboard/agents/new">Create Voice Agent</Link>
          </Button>
        </div>
      </aside>
    </>
  );
}

function MobileDashboardNav() {
  return (
    <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/90 px-4 py-3 shadow-sm backdrop-blur-xl md:hidden">
      <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-foreground" aria-label="VoiceForge dashboard">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-sm">
          <Logo size={20} />
        </span>
        <span>VoiceForge</span>
      </Link>
      <div className="flex items-center gap-2">
        <Button asChild size="sm" className="gap-1.5">
          <Link href="/dashboard/agents/new">
            <Plus className="h-3.5 w-3.5" />
            Agent
          </Link>
        </Button>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Open dashboard navigation">
              <Menu className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[86vw] max-w-sm overflow-y-auto p-0">
            <SheetHeader className="border-b border-border px-5 py-4 text-left">
              <SheetTitle className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-primary">
                  <Logo size={20} />
                </span>
                VoiceForge
              </SheetTitle>
              <SheetDescription>Build, test, and manage AI voice agents.</SheetDescription>
            </SheetHeader>
            <div className="px-3 py-4">
              <NavSections mobile />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}

function SidebarBrand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-3 rounded-2xl px-2 py-1.5 text-sidebar-foreground" aria-label="VoiceForge dashboard">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sidebar-border bg-card text-primary shadow-sm">
        <Logo size={23} />
      </span>
      <span>
        <span className="block font-[family-name:var(--font-serif)] text-xl leading-none">VoiceForge</span>
        <span className="mt-1 block text-xs text-sidebar-foreground/60">Voice agent builder</span>
      </span>
    </Link>
  );
}

function NavSections({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-5" aria-label={mobile ? 'Mobile dashboard navigation' : 'Dashboard navigation'}>
      {navSections.map((section) => (
        <div key={section.label}>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-sidebar-foreground/50">
            {section.label}
          </p>
          <div className="flex flex-col gap-1">
            {section.items.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== '/dashboard' && pathname?.startsWith(item.href));
              const link = (
                <Link
                  href={item.href}
                  className={cn(
                    'group flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all',
                    active
                      ? 'bg-sidebar-accent font-semibold text-sidebar-accent-foreground shadow-sm ring-1 ring-sidebar-border'
                      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                  )}
                >
                  <item.icon
                    className={cn(
                      'h-4 w-4 transition-colors',
                      active
                        ? 'text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/55 group-hover:text-sidebar-accent-foreground',
                    )}
                  />
                  {item.label}
                </Link>
              );
              return mobile ? (
                <SheetClose asChild key={item.href}>
                  {link}
                </SheetClose>
              ) : (
                <span key={item.href}>{link}</span>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
