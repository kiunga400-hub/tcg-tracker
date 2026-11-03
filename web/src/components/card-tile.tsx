import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Printing } from "@/lib/api";
import { cad, imageSrc } from "@/lib/format";

export function CardTile({ p }: { p: Printing }) {
  const href = `/cards/${encodeURIComponent(p.card_key)}`;
  return (
    <div className="flex flex-col gap-2">
      <Link href={href} className="group flex flex-col gap-2">
        <div className="aspect-[59/86] w-full overflow-hidden rounded-md bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element -- our API already serves a resized copy */}
          <img
            src={imageSrc(p.card_key)}
            alt={p.name}
            loading="lazy"
            className="h-full w-full object-contain transition-transform group-hover:scale-[1.02]"
          />
        </div>
        <div className="grid gap-0.5">
          <p className="line-clamp-2 text-sm leading-tight font-medium group-hover:underline">{p.name}</p>
          <p className="text-xs text-muted-foreground">
            {p.card_number} · {p.rarity}
            {p.art_label ? ` · ${p.art_label}` : ""}
          </p>
        </div>
      </Link>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold tabular-nums">
          {p.min_price == null ? "Out of stock" : `from ${cad(p.min_price)}`}
        </span>
        {p.store_count > 1 && (
          <Link
            href={href}
            className="inline-flex h-7 items-center gap-0.5 rounded-full border px-2.5 text-xs hover:bg-muted"
          >
            {p.store_count} stores <ChevronRight className="size-3" />
          </Link>
        )}
        {p.store_count === 1 && (
          <Badge variant="secondary" className="text-[11px] font-normal">
            1 store
          </Badge>
        )}
      </div>
    </div>
  );
}
