import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "Create your account" };

export default function SignupPage({ searchParams }: PageProps<"/signup">) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Create your Nexova account</h1>
        <p className="text-sm text-muted-foreground">Turn your TikTok Shop or Shopee catalogue into your own store.</p>
      </div>
      <Suspense>
        <SignupForm searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SignupForm({ searchParams }: Pick<PageProps<"/signup">, "searchParams">) {
  const params = await searchParams;
  return <AuthForm mode="signup" next={safeNextPath(params.next)} />;
}
