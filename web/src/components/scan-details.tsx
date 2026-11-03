"use client";

import { useMemo } from "react";

import type { ScanResult } from "@/components/scan-result";

// YOLO's two kinds of box, as the scanner names them
const FIELDS = [
  { key: "name", label: "Name", colour: "#34d399" },
  { key: "set_code", label: "Set code", colour: "#f472b6" },
] as const;

// The straightened card with YOLO's boxes drawn on it, as an image URL.
function annotatedCard(result: ScanResult): string | null {
  const card = result.images?.card;
  if (!card) return null;
  const canvas = document.createElement("canvas");
  canvas.width = card.width;
  canvas.height = card.height;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.drawImage(card, 0, 0);
  const line = Math.max(3, Math.round(card.width / 150));
  g.font = `600 ${line * 7}px system-ui, sans-serif`;
  for (const { key, label, colour } of FIELDS) {
    const field = result.fields?.[key];
    if (!field) continue;
    const [x1, y1, x2, y2] = field.box;
    g.lineWidth = line;
    g.strokeStyle = colour;
    g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const tag = `${label} ${Math.round(field.conf * 100)}%`;
    const tagHeight = line * 9;
    const tagY = y1 >= tagHeight ? y1 - tagHeight : y2;
    g.fillStyle = colour;
    g.fillRect(x1, tagY, g.measureText(tag).width + line * 3, tagHeight);
    g.fillStyle = "#0a0a0a";
    g.fillText(tag, x1 + line * 1.5, tagY + line * 7);
  }
  return canvas.toDataURL("image/jpeg", 0.8);
}

// Folded away under the result: what the detector found and what OCR read from each crop. Shoppers can ignore it;
// it explains a wrong or missing result, and shows the computer vision at work.
export function ScanDetails({ result }: { result: ScanResult }) {
  const card = useMemo(() => annotatedCard(result), [result]);
  const crops = FIELDS.map((f) => ({
    ...f,
    image: result.images?.crops?.[f.key]?.toDataURL("image/jpeg", 0.85),
    reads: [...new Set(f.key === "name" ? result.ocr?.nameTexts : result.ocr?.codeTexts)].filter(Boolean).slice(0, 4),
  }));
  const time = result.timings && Object.values(result.timings).reduce((a, b) => a + b, 0);
  if (!card && !crops.some((c) => c.image)) return null;

  return (
    <details className="group rounded-xl border bg-card sm:max-w-3xl">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
        <span className="mr-1.5 inline-block transition-transform group-open:rotate-90">›</span>
        What the scanner saw
      </summary>
      <div className="grid gap-4 border-t p-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
        {card && (
          <figure className="grid gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL drawn from the scan */}
            <img src={card} alt="Your card, straightened, with the detected boxes" className="w-full max-w-56 rounded-md" />
            <figcaption className="text-xs text-muted-foreground">
              Straightened, then YOLO boxes the name and the set code.
            </figcaption>
          </figure>
        )}
        <div className="grid content-start gap-4">
          {crops.map((c) => (
            <div key={c.key} className="grid gap-1.5">
              <p className="text-xs font-medium" style={{ color: c.colour }}>
                {c.label}
              </p>
              {c.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local data URL cut from the scan
                <img src={c.image} alt={`${c.label} crop`} className="max-h-16 w-fit max-w-full rounded bg-white" />
              ) : (
                <p className="text-xs text-muted-foreground">Not found on the card.</p>
              )}
              {c.reads.length > 0 && (
                <p className="font-mono text-xs break-words text-muted-foreground">
                  Read as: {c.reads.map((r) => `“${r}”`).join(", ")}
                </p>
              )}
            </div>
          ))}
          {time != null && (
            <p className="text-xs text-muted-foreground">
              {(time / 1000).toFixed(1)} s on this device: find and straighten, detect, then read and match.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}
