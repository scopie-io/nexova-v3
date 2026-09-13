import Image from "next/image";
import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center" aria-label="Nexova home">
      <Image src="/brand/logo-nexova-color.svg" alt="Nexova" width={120} height={32} priority className="h-7 w-auto" />
    </Link>
  );
}
