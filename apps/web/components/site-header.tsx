'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { HeaderAuth } from '@/components/auth/header-auth';
import { Logo } from '@/components/logo';

const demoSharePath =
  process.env.NEXT_PUBLIC_DEMO_SHARE_PATH ??
  '/a/ai-receptionist-62c5fb9c-330c-488a-84d9-05d1cc6672aa';

const navLinks = [
  { href: '/#product', label: 'Product' },
  { href: '/#workflow', label: 'Workflow' },
  { href: '/#compliance', label: 'Compliance' },
  { href: '/#demo-call', label: 'Demo call' },
  { href: '/#agencies', label: 'Agencies' },
  { href: '/pricing', label: 'Pricing' },
  { href: demoSharePath, label: 'Share page', externalIcon: true },
];

function isCurrent(pathname: string, href: string) {
  return href === pathname || (href === '/#product' && pathname === '/');
}

export function SiteHeader() {
  const pathname = usePathname();
  if (pathname?.startsWith('/dashboard')) return null;

  return (
    <header className="sticky top-0 z-50 overflow-x-hidden border-b border-orange-200/80 bg-[#fff7ed]/95 shadow-sm shadow-orange-950/5 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-8">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2.5 font-semibold tracking-tight text-stone-950"
          aria-label="VoiceForge home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-orange-200 bg-white text-orange-700 shadow-sm transition group-hover:border-orange-300 group-hover:bg-orange-50">
            <Logo size={21} />
          </span>
          <span className="font-serif text-xl leading-none">VoiceForge</span>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="hidden min-w-0 items-center gap-1 rounded-md border border-orange-200 bg-white/75 p-1 text-sm shadow-sm lg:flex"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`inline-flex h-9 items-center gap-1.5 rounded px-3 font-medium transition ${
                isCurrent(pathname, link.href)
                  ? 'bg-orange-100 text-orange-800'
                  : 'text-stone-700 hover:bg-orange-50 hover:text-orange-800'
              }`}
            >
              {link.label}
              {link.externalIcon ? <ArrowUpRight className="h-3.5 w-3.5" /> : null}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <HeaderAuth />
        </div>
      </div>

      <nav
        aria-label="Primary navigation mobile"
        className="grid grid-cols-1 gap-2 border-t border-orange-100 px-4 pb-3 pt-2 text-sm sm:grid-cols-4 md:px-8 lg:hidden"
      >
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`inline-flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md border px-3 font-medium transition ${
              isCurrent(pathname, link.href)
                ? 'border-orange-300 bg-orange-100 text-orange-800'
                : 'border-orange-200 bg-white/75 text-stone-700 hover:bg-orange-50 hover:text-orange-800'
            }`}
          >
            {link.label}
            {link.externalIcon ? <ArrowUpRight className="h-3.5 w-3.5" /> : null}
          </Link>
        ))}
      </nav>
    </header>
  );
}
