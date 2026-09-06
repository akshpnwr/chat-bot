"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/auth-client";

/**
 * The seeded accounts a reviewer signs in with.
 *
 * Written out here rather than imported from `prisma/seed.ts`, which is the
 * list's actual owner: that module pulls in Prisma and better-auth, so
 * importing it would drag the server into the browser bundle to read four
 * strings. The seed holds a third account -- Alan, who owns the 10,000-Message
 * Conversation -- deliberately left out, because the demo needs two people
 * talking to each other and a third set of credentials is only noise on the
 * way in.
 */
const DEMO_ACCOUNTS = [
  { email: "ada@example.com", password: "demo-password-1" },
  { email: "grace@example.com", password: "demo-password-2" },
] as const;

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * Seconds left before a throttled sign-in may be tried again, or zero.
   *
   * The server refuses repeated failures and says when to come back; holding
   * that here is what makes the form honour it. Without it the button is
   * immediately re-submittable and a person hammering it merely renews their
   * own refusal -- which is the behaviour the throttle exists to stop.
   */
  const [waitSeconds, setWaitSeconds] = useState(0);

  // Counts the wait down so the button re-enables on its own.
  //
  // One interval for as long as a wait is outstanding, cleared when it reaches
  // zero. The tick reads the previous value rather than closing over
  // `waitSeconds`, so the interval does not need re-creating each second.
  const waiting = waitSeconds > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      setWaitSeconds((remaining) => Math.max(0, remaining - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || waitSeconds > 0) return;
    setPending(true);
    setError(null);

    const { error: signInError } = await signIn.email({ email, password });

    if (signInError) {
      setError(signInError.message ?? "Could not sign in.");
      // A throttled refusal disables the button for as long as the server said,
      // so the next attempt is one that can actually succeed. Read from the
      // body, falling back to the standard header's seconds.
      const refusal = signInError as { retryAfterMs?: number; status?: number };
      if (refusal.status === 429) {
        setWaitSeconds(
          refusal.retryAfterMs === undefined
            ? 60
            : Math.ceil(refusal.retryAfterMs / 1000),
        );
      }
      setPending(false);
      return;
    }

    router.push("/app");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[400px] flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-[32px] leading-10 tracking-[-1.28px]">Sign in</h1>
        <div className="flex flex-col gap-1">
          <p className="text-[12px] leading-4 text-muted">Demo accounts</p>
          {DEMO_ACCOUNTS.map((account) => (
            <div
              key={account.email}
              className="flex flex-wrap items-center gap-x-1 gap-y-0 text-[12px] leading-4 text-muted"
            >
              <span className="font-mono">{account.email}</span>
              <CopyButton value={account.email} label={`${account.email} email`} />
              <span aria-hidden>&middot;</span>
              <span className="font-mono">{account.password}</span>
              <CopyButton
                value={account.password}
                label={`${account.email} password`}
              />
            </div>
          ))}
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-[14px] leading-5">
          Email
          <Input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-2 text-[14px] leading-5">
          Password
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error ? (
          <p role="alert" className="text-status-red text-[12px] leading-4">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending || waitSeconds > 0}>
          {pending
            ? "Signing in…"
            : waitSeconds > 0
              ? `Try again in ${waitSeconds}s`
              : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
