"use client";

import { useActionState, useState } from "react";
import { createStore, type CreateStoreState } from "@/app/dashboard/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateStoreForm() {
  const [state, action, pending] = useActionState<CreateStoreState, FormData>(createStore, {});
  const [name, setName] = useState(state.values?.name ?? "");
  const [slug, setSlug] = useState(state.values?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="store-name">Store name</Label>
        <Input
          id="store-name"
          name="name"
          required
          maxLength={120}
          placeholder="Goli Nutrition"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugEdited) setSlug(slugify(event.target.value));
          }}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="store-slug">Store address</Label>
        <Input
          id="store-slug"
          name="slug"
          required
          maxLength={40}
          placeholder="goli-nutrition"
          value={slug}
          onChange={(event) => {
            setSlugEdited(true);
            setSlug(event.target.value);
          }}
        />
      </div>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Creating…" : "Create store"}
      </Button>
      {state.error && (
        <Alert variant="destructive" className="sm:col-span-3">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
