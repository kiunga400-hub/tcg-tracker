import type { Metadata } from "next";

import { Scanner } from "@/components/scanner";

export const metadata: Metadata = {
  title: "Scan a card",
  description: "Point your phone at a Yu-Gi-Oh! card to see its prices at every Canadian store.",
};

export default function ScanPage() {
  return (
    <>
      <section className="bg-gradient-to-br from-violet-950 via-violet-900 to-indigo-900 text-white">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-3 px-5 pt-8 pb-6 sm:pt-10 sm:pb-8">
          <p className="text-sm text-white/70">Card scanner</p>
          <h1 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-5xl">Scan a card, see every price.</h1>
          <p className="max-w-xl text-white/80">
            Hold your phone flat and straight above the card, in good light, with the whole card in the frame and in
            focus.
          </p>
        </div>
      </section>
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6">
        <Scanner />
      </div>
    </>
  );
}
