import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { safeNextPath } from "@/lib/auth";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Log in to Nexova</h1>
        <p className="text-sm text-muted-foreground">Manage your store, products and orders.</p>
      </div>
      <Suspense>
        <LoginForm searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function LoginForm({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  return <AuthForm mode="login" next={safeNextPath(params.next)} initialError={error} />;
}
