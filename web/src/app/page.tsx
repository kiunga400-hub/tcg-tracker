import { Camera } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { SearchBox } from "@/components/search-box";
import { Skeleton } from "@/components/ui/skeleton";
import { cad, getDeals, getSets, getStores } from "@/lib/api";

export default function Home() {
  return (
    <>
      <section className="bg-gradient-to-br from-violet-950 via-violet-900 to-indigo-900 text-white">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 px-5 pt-8 pb-6 sm:pt-10 sm:pb-10">
          <Suspense fallback={<p className="text-sm text-white/70">Canadian stores</p>}>
            <StoreLine />
          </Suspense>
          <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl">
            Here to serve your Canadian Yu-Gi-Oh! TCG needs.
          </h1>
          <p className="max-w-xl text-white/80">
            Every in-stock single at Canadian stores, side by side. Find the cheapest copy in seconds.
          </p>
          <div className="max-w-xl">
            <SearchBox variant="hero" />
          </div>
          <Link
            href="/scan"
            className="inline-flex h-9 w-fit items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 text-sm font-medium hover:bg-white/20"
          >
            <Camera className="size-4" /> Scan a card with your phone
          </Link>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-8">
        <Suspense fallback={<Skeleton className="h-20 w-full" />}>
          <DealOfTheDay />
        </Suspense>
        <Suspense fallback={<Skeleton className="h-16 w-full" />}>
          <Stats />
        </Suspense>
        <section className="grid gap-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold">Browse by set</h2>
            <Link href="/sets" className="text-sm text-muted-foreground hover:text-foreground">
              All sets
            </Link>
          </div>
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <SetList />
          </Suspense>
        </section>
      </div>
    </>
  );
}

async function StoreLine() {
  const stores = await getStores();
  return <p className="text-sm text-white/70">{stores.map((s) => s.name).join(" · ")}</p>;
}

// the biggest saving today: same card, edition and condition (near mint), cheapest store vs priciest
async function DealOfTheDay() {
  const [[deal], stores] = await Promise.all([getDeals({ condition: "NM", min_price: 5, limit: 1 }), getStores()]);
  if (!deal) return null;
  const name = Object.fromEntries(stores.map((s) => [s.slug, s.name]));
  return (
    <Link
      href={`/cards/${encodeURIComponent(deal.card_key)}`}
      className="grid gap-1 rounded-xl border bg-card p-4 hover:bg-muted/50 sm:flex sm:items-center sm:justify-between"
    >
      <div>
        <p className="text-xs font-medium tracking-wide text-primary uppercase">Deal of the day</p>
        <p className="text-lg font-semibold">
          {deal.name} is {Math.round(deal.saving_pct * 100)}% cheaper at {name[deal.cheapest_store]}
        </p>
        <p className="text-sm text-muted-foreground">
          {deal.card_number} · {deal.rarity} · {deal.edition} · Near Mint
        </p>
      </div>
      <p className="text-sm tabular-nums">
        <span className="text-lg font-semibold">{cad(deal.low)}</span>{" "}
        <span className="text-muted-foreground line-through">{cad(deal.high)}</span>
      </p>
    </Link>
  );
}

async function Stats() {
  const [stores, sets] = await Promise.all([getStores(), getSets()]);
  const items = [
    { label: "stores", value: stores.length },
    { label: "listings in stock", value: stores.reduce((n, s) => n + s.listings_in_stock, 0) },
    { label: "sets", value: sets.length },
  ];
  return (
    <dl className="grid grid-cols-3 gap-3">
      {items.map((i) => (
        <div key={i.label} className="rounded-xl border p-3">
          <dt className="text-xs text-muted-foreground">{i.label}</dt>
          <dd className="text-lg font-semibold tabular-nums sm:text-xl">{i.value.toLocaleString("en-CA")}</dd>
        </div>
      ))}
    </dl>
  );
}

async function SetList() {
  const sets = (await getSets()).filter((s) => s.set_name).slice(0, 24);
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {sets.map((s) => (
        <li key={s.set_code}>
          <Link
            href={`/sets/${encodeURIComponent(s.set_code)}`}
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 hover:bg-muted/50"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{s.set_name}</span>
              <span className="text-xs text-muted-foreground">
                {s.set_code} · {s.cards_in_stock} in stock
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">from {cad(s.cheapest)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
