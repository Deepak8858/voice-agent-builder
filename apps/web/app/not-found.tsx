import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">404</p>
      <h1 className="mt-3 font-[family-name:var(--font-serif)] text-3xl tracking-tight">
        Page not found
      </h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
        That page does not exist or was moved. Head back to the home page or open the dashboard.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
        >
          Home
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}
