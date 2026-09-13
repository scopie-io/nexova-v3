import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-2">
          <Link href="/login" className={buttonVariants({ variant: "ghost", size: "lg" })}>
            Log in
          </Link>
          <Link href="/signup" className={buttonVariants({ size: "lg" })}>
            Get started
          </Link>
        </nav>
      </header>

      <main className="mx-auto grid w-full max-w-3xl flex-1 content-center gap-6 px-4 py-16 text-center sm:px-6">
        <p className="text-sm font-semibold tracking-wide text-brand-ink uppercase">For TikTok Shop and Shopee sellers</p>
        <h1 className="text-4xl font-black tracking-tight text-balance sm:text-5xl">
          Your marketplace shop, as your own online store
        </h1>
        <p className="mx-auto max-w-xl text-lg text-pretty text-muted-foreground">
          Paste your shop link. Nexova brings in your products, builds the website, and gives you checkout, orders
          and inventory in one place.
        </p>
        <div className="flex justify-center gap-3">
          <Link href="/signup" className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 text-base")}>
            Create your store
          </Link>
        </div>
      </main>
    </div>
  );
}
