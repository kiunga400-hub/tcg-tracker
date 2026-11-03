"use client";

import { Camera, ImageUp, LoaderCircle, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ScanResultView, type ScanResult } from "@/components/scan-result";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The scanner itself (public/scanner/, copied from github.com/kiunga400-hub/scanner) is a plain ES module with its
// own models, so the bundler leaves it alone and the browser loads it only when someone starts a scan. It then
// downloads OpenCV.js, ONNX Runtime and ~13 MB of models once; the browser caches them after that. Photos are read on
// the device and never uploaded.
const SCANNER_URL = "/scanner/card-scanner.js";

type Hint = { code: string; text: string; ok: boolean; progress: number };
type Guide = { stop(): void; retry(): void; capture(): void };
type CardScanner = {
  load(onProgress?: (message: string) => void): Promise<void>;
  identify(image: Blob): Promise<ScanResult>;
  startGuide(
    video: HTMLVideoElement,
    overlay: HTMLCanvasElement,
    options: { onHint(h: Hint): void; onResult(r: ScanResult): void; onError(e: unknown): void },
  ): Guide;
};

let scannerPromise: Promise<CardScanner> | null = null;
function getScanner(): Promise<CardScanner> {
  scannerPromise ??= import(/* webpackIgnore: true */ SCANNER_URL).then(
    (m: { CardScanner: new (options: { baseUrl: string }) => CardScanner }) => new m.CardScanner({ baseUrl: "/scanner/" }),
  );
  return scannerPromise;
}

type Mode = "idle" | "camera" | "reading" | "result";

export function Scanner() {
  const [mode, setMode] = useState<Mode>("idle");
  const [hint, setHint] = useState<Hint | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const guideRef = useRef<Guide | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const stopCamera = () => {
    guideRef.current?.stop();
    guideRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  // release the camera when leaving the page
  useEffect(() => stopCamera, []);

  // the video element only exists in camera mode, so the guide starts once it has rendered
  useEffect(() => {
    if (mode !== "camera" || guideRef.current || !videoRef.current || !overlayRef.current) return;
    let cancelled = false;
    getScanner()
      .then((scanner) => {
        if (cancelled || !videoRef.current || !overlayRef.current) return;
        guideRef.current = scanner.startGuide(videoRef.current, overlayRef.current, {
          onHint: (h) => {
            if (h.code === "camera_error") setCameraFailed(true);
            setHint(h);
          },
          onResult: (r) => {
            stopCamera();
            setResult(r);
            setMode("result");
          },
          onError: (e) => console.error(e),
        });
      })
      .catch(() => setError("The scanner couldn't load. Check your connection and try again."));
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const startCamera = () => {
    setError(null);
    setCameraFailed(false);
    setHint({ code: "loading", text: "Loading the scanner…", ok: false, progress: 0 });
    setMode("camera");
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    stopCamera();
    setError(null);
    setMode("reading");
    setHint({ code: "loading", text: "Loading the scanner…", ok: false, progress: 0 });
    try {
      const scanner = await getScanner();
      await scanner.load((message) => setHint({ code: "loading", text: message, ok: false, progress: 0 }));
      setHint({ code: "reading", text: "Reading the card…", ok: true, progress: 1 });
      setResult(await scanner.identify(file));
      setMode("result");
    } catch {
      setError("Something went wrong reading that photo. Try another one.");
      setMode("idle");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const upload = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => readFile(e.target.files?.[0])}
      />
      <Button variant="outline" size="lg" className="h-10 px-4" onClick={() => fileRef.current?.click()}>
        <ImageUp /> Upload a photo
      </Button>
    </>
  );

  if (mode === "result" && result) {
    return (
      <ScanResultView
        result={result}
        onAgain={() => {
          setResult(null);
          startCamera();
        }}
        uploadButton={upload}
      />
    );
  }

  return (
    <section className="grid gap-4">
      {mode === "idle" && (
        <div className="grid gap-4 rounded-xl border bg-card p-5 sm:max-w-xl">
          <ol className="grid gap-1.5 text-sm text-muted-foreground">
            <li>1. Lay the card on a plain, dark surface.</li>
            <li>2. Hold your phone flat above it until the card fills most of the frame.</li>
            <li>3. Keep still: it takes the photo by itself once the card is sharp.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" className="h-10 px-4" onClick={startCamera}>
              <Camera /> Start camera
            </Button>
            {upload}
          </div>
          <p className="text-xs text-muted-foreground">
            English cards only. Runs on your device: photos are never uploaded. The first scan downloads about 15 MB.
          </p>
        </div>
      )}

      {mode === "camera" && (
        <div className="grid gap-3 sm:max-w-xl">
          <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 size-full object-contain" />
            <canvas ref={overlayRef} className="absolute inset-0 size-full" />
            {hint && (
              <p
                aria-live="polite"
                className={cn(
                  "absolute inset-x-3 top-3 rounded-lg px-3 py-2 text-center text-sm font-medium",
                  hint.ok ? "bg-emerald-500/90 text-emerald-950" : "bg-black/70 text-white",
                )}
              >
                {cameraFailed ? "Your camera isn't available here. Upload a photo instead." : hint.text}
              </p>
            )}
            <div
              className="absolute bottom-0 left-0 h-1 bg-emerald-500 transition-[width]"
              style={{ width: `${Math.round(100 * (hint?.progress ?? 0))}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {!cameraFailed && (
              <Button size="lg" className="h-10 px-4" onClick={() => guideRef.current?.capture()}>
                <Camera /> Take photo now
              </Button>
            )}
            {upload}
            <Button
              variant="ghost"
              size="lg"
              className="h-10 px-4"
              onClick={() => {
                stopCamera();
                setMode("idle");
              }}
            >
              <Square /> Stop
            </Button>
          </div>
        </div>
      )}

      {mode === "reading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <LoaderCircle className="size-4 animate-spin" /> {hint?.text}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
