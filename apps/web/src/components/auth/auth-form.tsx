"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn, signInWithGoogle, signUp, type AuthFormState } from "@/app/(auth)/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "login" | "signup";

export function AuthForm({ mode, next, initialError }: { mode: Mode; next: string; initialError?: string }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(
    mode === "login" ? signIn : signUp,
    { error: initialError },
  );

  if (state.message) {
    return (
      <Alert>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  const nextQuery = next === "/dashboard" ? "" : `?next=${encodeURIComponent(next)}`;

  return (
    <div className="grid gap-5">
      <form action={signInWithGoogle}>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="outline" size="lg" className="w-full">
          Continue with Google
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or with email
        <span className="h-px flex-1 bg-border" />
      </div>

      <form action={action} className="grid gap-4">
        <input type="hidden" name="next" value={next} />
        {mode === "signup" && (
          <div className="grid gap-1.5">
            <Label htmlFor="name">Your name</Label>
            <Input id="name" name="name" autoComplete="name" required maxLength={80} />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={state.email}
            aria-invalid={Boolean(state.error)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            aria-invalid={Boolean(state.error)}
          />
        </div>

        {state.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? "One moment…" : mode === "login" ? "Log in" : "Create account"}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        {mode === "login" ? (
          <>
            New to Nexova?{" "}
            <Link className="font-medium text-brand-ink hover:underline" href={`/signup${nextQuery}`}>
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link className="font-medium text-brand-ink hover:underline" href={`/login${nextQuery}`}>
              Log in
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
