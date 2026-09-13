import type { Metadata } from "next";
import { Suspense } from "react";
import { CreateStoreForm } from "@/components/dashboard/create-store-form";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your stores" };

const STATUS_LABEL = { draft: "Draft", live: "Live", suspended: "Suspended" } as const;

export default function DashboardPage() {
  return (
    <div className="grid gap-8">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Your stores</h1>
        <p className="text-sm text-muted-foreground">
          Every store you own or help run. Building a store from a TikTok Shop or Shopee link arrives here next.
        </p>
      </div>

      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading your stores…</p>}>
        <StoreList />
      </Suspense>

      <section className="grid gap-4 rounded-xl border bg-card p-5">
        <div className="grid gap-1">
          <h2 className="font-semibold">Create a store by hand</h2>
          <p className="text-sm text-muted-foreground">
            The address becomes your store&apos;s web address and can&apos;t be changed later.
          </p>
        </div>
        <CreateStoreForm />
      </section>
    </div>
  );
}

async function StoreList() {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: stores, error } = await supabase
    .from("stores")
    .select("id, name, slug, status, created_at, store_members!inner(role)")
    .eq("store_members.user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return <p className="text-sm text-destructive">We couldn&apos;t load your stores. Refresh to try again.</p>;
  }

  if (!stores.length) {
    return (
      <div className="rounded-xl border border-dashed bg-background p-8 text-center">
        <p className="font-medium">You don&apos;t have a store yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Create one below to get started.</p>
      </div>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {stores.map((store) => (
        <li key={store.id} className="grid gap-2 rounded-xl border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold">{store.name}</p>
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
              {STATUS_LABEL[store.status]}
            </span>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{store.slug}</p>
          <p className="text-xs text-muted-foreground capitalize">{store.store_members[0]?.role}</p>
        </li>
      ))}
    </ul>
  );
}
