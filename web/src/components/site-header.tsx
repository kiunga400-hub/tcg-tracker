import Link from "next/link";
import { Suspense } from "react";

import { HeaderSearch } from "@/components/header-search";

const LINKS = [
  { href: "/scan", label: "Scan" },
  { href: "/deals", label: "Deals" },
  { href: "/sets", label: "Sets" },
  { href: "/stores", label: "Stores" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            CS
          </span>
          Card Scout CA
        </Link>
        <nav className="flex gap-4 text-sm text-muted-foreground">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="hover:text-foreground">
              {l.label}
            </Link>
          ))}
        </nav>
        <Suspense>
          <HeaderSearch />
        </Suspense>
      </div>
    </header>
  );
}
