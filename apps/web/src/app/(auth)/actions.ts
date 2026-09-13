"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNextPath } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState = {
  error?: string;
  message?: string;
  email?: string;
};

const credentials = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters for your password."),
});

function callbackUrl(next: string) {
  return `${publicEnv.siteUrl}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const parsed = credentials.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message, email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    const unconfirmed = error.code === "email_not_confirmed";
    return {
      error: unconfirmed
        ? "Confirm your email first. We sent a link when you signed up."
        : "That email and password don't match. Try again or reset your password.",
      email,
    };
  }

  redirect(safeNextPath(formData.get("next")));
}

const signUpFields = credentials.extend({
  name: z.string().trim().min(1, "Tell us your name.").max(80, "Keep your name under 80 characters."),
});

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const parsed = signUpFields.safeParse({
    email,
    password: formData.get("password"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message, email };
  }

  const next = safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.name },
      emailRedirectTo: callbackUrl(next),
    },
  });
  if (error) {
    return {
      error:
        error.code === "user_already_exists"
          ? "An account with this email already exists. Log in instead."
          : error.message,
      email,
    };
  }

  // With email confirmation on, there is no session until the link is clicked.
  if (!data.session) {
    return { message: `We sent a confirmation link to ${parsed.data.email}. Open it to finish signing up.`, email };
  }
  redirect(next);
}

export async function signInWithGoogle(formData: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(safeNextPath(formData.get("next"))) },
  });
  if (error || !data.url) {
    redirect(`/login?error=${encodeURIComponent("Google sign-in is not available right now.")}`);
  }
  redirect(data.url);
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
