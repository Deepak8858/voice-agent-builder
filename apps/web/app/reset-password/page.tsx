'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Logo } from '@/components/logo';

// Must match supabase/config.toml `minimum_password_length`, otherwise the
// browser accepts a short password and Supabase rejects it after the round trip.
const MIN_PASSWORD_LENGTH = 12;

export default function ResetPasswordPage() {
  const supabase = createBrowserSupabaseClient();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState('');
  const [needsNonce, setNeedsNonce] = useState(false);

  useEffect(() => {
    // The recovery link signs the user in with a temporary session
    // (via the code/hash in the URL, handled by supabase-js). Verify it.
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setHasSession(!!data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setHasSession(true);
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.updateUser(
      nonce ? { password, nonce } : { password },
    );

    if (error) {
      // supabase/config.toml sets secure_password_change, so Supabase demands an
      // emailed nonce whenever the session behind this reset is older than 24h.
      // Without this branch updateUser just keeps returning the same error and
      // the form offers no way forward. Ask for the code and retry with it.
      if (error.code === 'reauthentication_needed') {
        const sent = await supabase.auth.reauthenticate();
        setNeedsNonce(true);
        setError(
          sent.error
            ? sent.error.message
            : 'For security, enter the 6-digit code we just emailed you and submit again.',
        );
      } else {
        setError(error.message);
      }
      setLoading(false);
      return;
    }

    setLoading(false);
    setDone(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <Logo className="mx-auto" />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">
            Choose a new password
          </h1>
        </div>

        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {done ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
              Your password has been updated.
            </div>
            <Button asChild className="w-full">
              <Link href="/dashboard">Continue to dashboard</Link>
            </Button>
          </div>
        ) : hasSession === false ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              This reset link is invalid or has expired. Request a new one.
            </div>
            <Button asChild variant="outline" className="w-full">
              <Link href="/forgot-password">Request new link</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                placeholder="••••••••"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
            </div>
            {needsNonce && (
              <div className="space-y-2">
                <Label htmlFor="nonce">Email verification code</Label>
                <Input
                  id="nonce"
                  inputMode="numeric"
                  placeholder="123456"
                  value={nonce}
                  onChange={(e) => setNonce(e.target.value)}
                  required
                  autoComplete="one-time-code"
                />
              </div>
            )}
            <Button type="submit" className="w-full" loading={loading} disabled={hasSession === null}>
              Update password
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
