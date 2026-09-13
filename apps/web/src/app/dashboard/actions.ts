"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type CreateStoreState = {
  error?: string;
  values?: { name: string; slug: string };
};

const storeFields = z.object({
  name: z.string().trim().min(1, "Give your store a name.").max(120, "Keep the name under 120 characters."),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "Use 3-40 lowercase letters, numbers or hyphens."),
});

export async function createStore(_prev: CreateStoreState, formData: FormData): Promise<CreateStoreState> {
  await requireUser();
  const values = { name: String(formData.get("name") ?? ""), slug: String(formData.get("slug") ?? "") };
  const parsed = storeFields.safeParse(values);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message, values };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_store", { p_name: parsed.data.name, p_slug: parsed.data.slug });
  if (error) {
    // create_store raises messages written for merchants (taken, reserved, invalid).
    return { error: error.message, values };
  }

  revalidatePath("/dashboard");
  return {};
}
