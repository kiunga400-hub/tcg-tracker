"use client";

import { Camera, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { CardTile } from "@/components/card-tile";
import { ScanDetails } from "@/components/scan-details";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Printing } from "@/lib/api";

// What public/scanner/card-scanner.js returns (see the scanner repo's README). Its card list comes from YGOPRODeck,
// so a card it recognises may still be one no store of ours lists.
export type ScannedCard = {
  name: string;
  setCode: string | null;
  setName: string | null;
  rarities: string[];
  possibleSetCodes: string[];
};
export type ScanResult = {
  status: "confirmed" | "likely" | "unsure" | "rejected" | "no_card" | "not_identified";
  card: ScannedCard | null;
  alternatives?: ScannedCard[];
  reasons?: string[];
  fields?: Partial<Record<"name" | "set_code", { box: [number, number, number, number]; conf: number }>>;
  images?: { card?: HTMLCanvasElement; crops?: Partial<Record<"name" | "set_code", HTMLCanvasElement>> };
  ocr?: { nameTexts: string[]; codeTexts: string[] };
  timings?: Record<string, number>;
};

// Every printing we track for the scanned code (all rarities, in stock or not), through the API's search; a card
// whose code wasn't read is looked up by its exact name instead.
function usePrintings(card: ScannedCard | null): Printing[] | null {
  const [found, setFound] = useState<{ key: string; items: Printing[] } | null>(null);
  const key = card ? (card.setCode ?? `name:${card.name}`) : "";

  useEffect(() => {
    if (!card) return;
    const ctrl = new AbortController();
    const q = card.setCode ?? card.name;
    fetch(`/api/search?${new URLSearchParams({ q, in_stock: "false", limit: "48" })}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((data: { items: Printing[] }) => {
        const same = (p: Printing) =>
          card.setCode ? p.card_number === card.setCode : p.name.toLowerCase() === card.name.toLowerCase();
        setFound({ key, items: data.items.filter(same) });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFound({ key, items: [] });
      });
    return () => ctrl.abort();
  }, [card, key]);

  return found?.key === key ? found.items : null;
}

const STATUS = {
  confirmed: null,
  likely: "Check this is your card",
  unsure: "Not sure about this one",
} as const;

export function ScanResultView({
  result,
  onAgain,
  uploadButton,
}: {
  result: ScanResult;
  onAgain: () => void;
  uploadButton: ReactNode;
}) {
  const [card, setCard] = useState(result.card);
  const printings = usePrintings(card);
  const photo = result.images?.card?.toDataURL("image/jpeg", 0.7);
  // a confirmed read (code and name agree) needs no second guesses
  const others =
    result.status === "confirmed" ? [] : (result.alternatives ?? []).filter((a) => a !== card).slice(0, 4);
  const status = card === result.card && result.status in STATUS ? STATUS[result.status as keyof typeof STATUS] : null;

  const actions = (
    <div className="flex flex-wrap gap-2">
      <Button size="lg" className="h-10 px-4" onClick={onAgain}>
        <Camera /> Scan another
      </Button>
      {uploadButton}
    </div>
  );

  if (!card) {
    return (
      <section className="grid gap-4 rounded-xl border bg-card p-5 sm:max-w-xl">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">
            {result.status === "rejected" ? "Let's retake that photo" : "We couldn't recognise that card"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {(result.reasons?.length ? result.reasons : ["Fit the whole card in the frame, flat and in good light."]).join(" ")}
          </p>
        </div>
        {actions}
        <ScanDetails result={result} />
        <p className="text-sm text-muted-foreground">
          Or <Link href="/search" className="underline underline-offset-4">search by name or card number</Link>.
        </p>
      </section>
    );
  }

  const setCode = printings?.[0]?.set_code;
  return (
    <section className="grid gap-6">
      <div className="flex gap-4">
        {photo && (
          // eslint-disable-next-line @next/next/no-img-element -- a local data URL of the scanned photo
          <img src={photo} alt="Your scan" className="w-20 shrink-0 self-start rounded-md sm:w-28" />
        )}
        <div className="grid content-start gap-1.5">
          {status && (
            <Badge variant="secondary" className="w-fit">
              {status}
            </Badge>
          )}
          <h2 className="text-2xl font-semibold tracking-tight">{card.name}</h2>
          <p className="text-sm text-muted-foreground">
            {card.setCode ?? "Card number not read"}
            {card.setName ? ` · ${card.setName}` : ""}
          </p>
          {card.rarities.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Printed as {card.rarities.join(", ")}
              {card.rarities.length > 1 ? ". Check yours below." : "."}
            </p>
          )}
        </div>
      </div>

      {others.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">Not your card? Tap the right one:</p>
          <div className="flex flex-wrap gap-2">
            {others.map((a) => (
              <Button key={`${a.name}|${a.setCode}`} variant="outline" className="h-auto py-1.5" onClick={() => setCard(a)}>
                {a.name} · {a.setCode ?? "?"}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xl font-semibold">
            {card.setCode ? `Every rarity of ${card.setCode} we track` : `Every printing of ${card.name} we track`}
          </h3>
          <div className="flex gap-4 text-sm text-muted-foreground">
            {setCode && (
              <Link href={`/sets/${encodeURIComponent(setCode)}`} className="hover:text-foreground">
                Browse the set
              </Link>
            )}
            <Link
              href={`/search?${new URLSearchParams({ q: card.setCode ?? card.name })}`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Search className="size-3.5" /> Search it up
            </Link>
          </div>
        </div>
        {printings === null ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="aspect-[59/86] w-full" />
            ))}
          </div>
        ) : printings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None of our stores list {card.setCode ?? card.name} right now.{" "}
            <Link
              href={`/search?${new URLSearchParams({ q: card.name })}`}
              className="underline underline-offset-4 hover:text-foreground"
            >
              See other printings of {card.name}
            </Link>
            .
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {printings.map((p) => (
              <CardTile key={p.card_key} p={p} />
            ))}
          </div>
        )}
      </div>

      {actions}
      <ScanDetails result={result} />
    </section>
  );
}
