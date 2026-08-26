'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { HeaderAuth } from '@/components/auth/header-auth';
import { Logo } from '@/components/logo';

const demoSharePath =
  process.env.NEXT_PUBLIC_DEMO_SHARE_PATH ??
  '/a/ai-receptionist-62c5fb9c-330c-488a-84d9-05d1cc6672aa';

const navLinks = [
  { href: '/#product', label: 'Product' },
  { href: '/how-it-works', label: 'Workflow' },
  { href: '/compliance', label: 'Compliance' },
  { href: '/templates', label: 'Templates' },
  { href: '/for-agencies', label: 'Agencies' },
  { href: '/pricing', label: 'Pricing' },
  { href: demoSharePath, label: 'Share page', externalIcon: true },
];

function isCurrent(pathname: string, href: string) {
  return href === pathname || (href === '/#product' && pathname === '/');
}

export function SiteHeader() {
  // Avoid calling usePathname during the first SSR/prerender pass of special
  // routes (Next 16 workStore invariant on /_not-found and /_global-error).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const pathname = usePathname();
  if (!mounted) return null;
  if (pathname?.startsWith('/dashboard')) return null;

  return (
    <header className="sticky top-0 z-50 overflow-x-hidden border-b border-white/10 bg-[#06130f]/95 text-[#fbf5e7] shadow-lg shadow-black/20 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-8">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-2.5 font-semibold tracking-tight text-[#fbf5e7]"
          aria-label="VoiceForge home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-md border border-[#bfff4a]/30 bg-[#bfff4a]/10 text-[#bfff4a] shadow-sm transition group-hover:border-[#bfff4a]/60 group-hover:bg-[#bfff4a]/15">
            <Logo size={21} />
          </span>
          <span className="font-serif text-xl leading-none">VoiceForge</span>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="hidden min-w-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.06] p-1 text-sm shadow-sm lg:flex"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`inline-flex h-9 items-center gap-1.5 rounded px-3 font-medium transition ${
                isCurrent(pathname, link.href)
                  ? 'bg-[#bfff4a] text-[#07130f]'
                  : 'text-[#dbe7dd] hover:bg-white/10 hover:text-white'
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
        className="flex gap-2 overflow-x-auto border-t border-white/10 px-4 pb-3 pt-2 text-sm md:px-8 lg:hidden"
      >
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 font-medium transition ${
              isCurrent(pathname, link.href)
                ? 'border-[#bfff4a] bg-[#bfff4a] text-[#07130f]'
                : 'border-white/10 bg-white/[0.06] text-[#dbe7dd] hover:bg-white/10 hover:text-white'
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
