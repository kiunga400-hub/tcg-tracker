/*
 * Yu-Gi-Oh card scanner (English cards), runs entirely in the browser.
 *
 *   Step 1  find the card in the photo, check it (tilt, size, blur, light, glare), straighten it   (OpenCV.js)
 *   Step 2  find the name bar and the set code on the straightened card                             (YOLO, onnxruntime-web)
 *   Step 3  read both and match them to a real printing in the card list                            (PaddleOCR recogniser + fuzzy match)
 *
 * Usage:
 *   import { CardScanner } from "./card-scanner.js";
 *   const scanner = new CardScanner({ baseUrl: "/scanner/" });   // folder that holds models/ and data/
 *   await scanner.load(p => console.log(p));                      // downloads ~13 MB once
 *   const result = await scanner.identify(fileOrImageOrCanvas);   // one photo
 *   const guide = scanner.startGuide(videoEl, overlayCanvas, {   // live camera with hints + auto-capture
 *     onHint: h => ..., onResult: r => ... });
 *   guide.stop();
 *
 * See README.md for the result format.
 */

const DEFAULTS = {
  baseUrl: "./",
  yoloModel: "models/card_fields.onnx",   // paths are relative to baseUrl
  ocrModel: "models/ocr_rec.onnx",
  opencvUrl: "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
  ortUrl: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.wasm.min.js",
  ortWasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/",
  // Photo checks (same numbers as pipeline/step1_straighten.py)
  minCardPx: 500,       // card height in the photo; below this the set code is too small to read
  minSharp: 25,         // detail score; lower is blurry
  maxGlare: 2,          // % of the card blown out to white
  minBright: 70,        // average brightness 0-255
  maxEdgeRatio: 1.15,   // far edge vs near edge; more means the phone was tilted
  maxCornerOff: 7,      // degrees a corner may be off square
  minFieldConf: 0.4,    // YOLO box confidence below this counts as not found
  minFill: 0.55,        // live guide: card must fill this much of the frame before capturing
};

const CARD_W = 1180, CARD_H = 1720, MARGIN = 80, WORK = 1000, IMGSZ = 640;
const CLASSES = ["name", "set_code"];
const SAME = { O: "0", Q: "0", D: "0", C: "0", U: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
const normCode = t => t.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[OQDCUILSBZG]/g, c => SAME[c]);
const normName = t => t.toLowerCase().replace(/[^a-z0-9]/g, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
}

export class CardScanner {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    if (!this.o.baseUrl.endsWith("/")) this.o.baseUrl += "/";
    this.ready = null;
  }

  url(path) { return new URL(this.o.baseUrl + path, location.href).href; }

  /* Download OpenCV, the ONNX runtime, both models and the card list. Safe to call more than once. */
  load(onProgress = () => {}) {
    if (!this.ready) this.ready = this._load(onProgress);
    return this.ready;
  }

  async _load(onProgress) {
    onProgress("Loading OpenCV and the model runtime");
    if (!window.cv) await loadScript(this.o.opencvUrl);
    if (!window.ort) await loadScript(this.o.ortUrl);
    let c = window.cv;
    if (c instanceof Promise) c = await c;
    else if (!c.Mat) await new Promise(r => { c.onRuntimeInitialized = r; });
    this.cv = c; window.cv = c;
    this.ort = window.ort;
    this.ort.env.wasm.numThreads = 1;
    this.ort.env.wasm.wasmPaths = this.o.ortWasmPaths;

    onProgress("Loading the models and card list");
    // A host that won't serve .onnx files can serve them base64-encoded as .b64.txt instead.
    const bin = async u => {
      const r = await fetch(this.url(u)); if (!r.ok) throw new Error(`Could not load ${u} (${r.status})`);
      if (!u.endsWith(".b64.txt")) return r.arrayBuffer();
      const b = atob((await r.text()).trim()), a = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
      return a.buffer;
    };
    const [yolo, ocr, chars, db] = await Promise.all([
      bin(this.o.yoloModel),
      bin(this.o.ocrModel),
      fetch(this.url("models/rec_chars.json")).then(r => r.json()),
      fetch(this.url("data/carddb.json")).then(r => r.json()),
    ]);
    this.yolo = await this.ort.InferenceSession.create(new Uint8Array(yolo), { executionProviders: ["wasm"] });
    this.ocr = await this.ort.InferenceSession.create(new Uint8Array(ocr), { executionProviders: ["wasm"] });
    this.ocrChars = [""].concat(chars, [" "]);
    this.db = db;
    this.codeKeys = new Map(); this.codesByName = new Map();
    for (const [code, [n]] of Object.entries(db.codes)) {
      const k = normCode(code);
      if (!this.codeKeys.has(k)) this.codeKeys.set(k, []);
      this.codeKeys.get(k).push(code);
      if (!this.codesByName.has(n)) this.codesByName.set(n, []);
      this.codesByName.get(n).push(code);
    }
    this.nameNorms = db.names.map(normName);
    onProgress("Ready");
  }

  /* ================= Public: identify one photo ================= */

  /* image: File/Blob, HTMLImageElement, HTMLCanvasElement, ImageBitmap or HTMLVideoElement.
     Returns { status, card, alternatives, reasons, warnings, fields, crops, timings }.
     status: "confirmed" | "likely" | "unsure" | "rejected" | "no_card" | "not_identified" */
  async identify(image, { corners = null } = {}) {
    await this.load();
    const cv = this.cv, t0 = performance.now();
    const canvas = await this._toCanvas(image, 4096);
    const src = cv.imread(canvas);
    try {
      let method = "given corners";
      if (!corners) {
        const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        const found = this._findCardAnyZoom(rgb); rgb.delete();
        if (!found) return { status: "no_card", reasons: ["No card found. Fit the whole card in the photo on a plain background."], card: null };
        corners = found.corners; method = found.method;
      }
      const tilt = this._tilt(corners);
      if (tilt.bad && method !== "whole photo") {
        return { status: "rejected", card: null, corners, tilt,
          reasons: [`Photo taken at an angle (far edge ${Math.round(100 * (tilt.ratio - 1))}% shorter). Hold the phone flat, straight above the card.`] };
      }
      const checks = this._checkPhoto(src, corners, canvas.photoScale || 1);
      const card = this._straighten(src, corners);
      const t1 = performance.now();
      const found = await this._detect(card);
      const crops = {};
      for (const cls of CLASSES) {
        const f = found[cls];
        if (!f || f.conf < this.o.minFieldConf) continue;
        const pad = 6, [x1, y1, x2, y2] = f.box;
        crops[cls] = this._hiResCrop(src, card.geom, [Math.max(0, x1 - pad), Math.max(0, y1 - pad), Math.min(card.width, x2 + pad), Math.min(card.height, y2 + pad)]);
      }
      const t2 = performance.now();
      const read = await this._read(card, crops);
      const res = this._decide(read.codeTexts, read.nameTexts);
      const t3 = performance.now();
      const out = {
        status: res ? res.level : "not_identified",
        card: res ? this._cardInfo(res.pick) : null,
        alternatives: res ? res.alts.map(a => this._cardInfo(a)) : [],
        warnings: checks.reasons, reasons: [],
        fields: found, ocr: read, corners, tilt, method, sharpness: checks.sharp,
        images: { card, crops },
        timings: { step1: Math.round(t1 - t0), step2: Math.round(t2 - t1), step3: Math.round(t3 - t2) },
      };
      return out;
    } finally { src.delete(); }
  }

  _cardInfo(c) {
    const e = c.code ? this.db.codes[c.code] : null;
    return {
      name: this.db.names[c.n],
      setCode: c.code,                                                     // null when the code couldn't be read
      setName: e ? this.db.sets[e[1]] : null,
      rarities: e ? e[2].map(r => this.db.rarities[r] || "Unknown") : [],  // more than one: ask the user
      possibleSetCodes: c.code ? [c.code] : (this.codesByName.get(c.n) || []),
      codeScore: Math.round(c.cs), nameScore: Math.round(c.ns),
    };
  }

  /* ================= Public: live camera guide ================= */

  /* Starts the back camera in `video`, draws the guide on `overlay` (a canvas laid exactly over the video),
     and calls onHint({ code, text, ok, progress }) every frame. When the card has been flat, sharp and
     still for a moment it captures a short burst, identifies the sharpest frame and calls onResult(result).
     Returns { stop(), retry() }. */
  startGuide(video, overlay, { onHint = () => {}, onResult = () => {}, onError = e => console.error(e),
                               holdFrames = 3, intervalMs = 180, autoCapture = true } = {}) {
    let stopped = false, busy = false, goodRun = 0, last = null, stream = null, timer = null;
    const ctrl = {
      stop: () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); },
      retry: () => { busy = false; goodRun = 0; loop(); },
      capture: () => capture(),
    };
    const hint = (code, text, ok = false, progress = 0) => onHint({ code, text, ok, progress });

    const capture = async () => {
      busy = true;
      hint("capturing", "Hold still…", true, 1);
      try {
        const frames = [];
        for (let i = 0; i < 3; i++) { frames.push(await this._toCanvas(video, 4096)); await sleep(90); }
        // Sharpest frame first; fall back to the others if it can't be identified confidently.
        const scored = frames.map(f => ({ f, s: this._quickSharpness(f) })).sort((a, b) => b.s - a.s);
        let best = null; const votes = new Map();
        for (const { f } of scored) {
          const r = await this.identify(f);
          if (r.card) { const k = r.card.name + "|" + r.card.setCode; votes.set(k, (votes.get(k) || 0) + 1); }
          if (!best || rank(r) > rank(best)) best = r;
          if (r.status === "confirmed") break;
        }
        if (best && best.card && votes.size > 1) best.votes = Object.fromEntries(votes);
        hint("done", best && best.card ? `Found: ${best.card.name}` : "Couldn't identify the card. Try again.", !!(best && best.card), 1);
        onResult(best);
      } catch (e) { onError(e); busy = false; loop(); }
    };
    const rank = r => ({ confirmed: 4, likely: 3, unsure: 2, not_identified: 1 }[r.status] || 0);

    const tick = async () => {
      if (stopped || busy) return;
      if (!video.videoWidth) { hint("starting", "Starting camera…"); return; }
      const st = this._frameState(video);
      this._drawGuide(overlay, video, st);
      if (!st.corners) { goodRun = 0; hint("no_card", "Fit the whole card inside the frame"); return; }
      const moved = last ? this._cornerShift(last, st.corners) / Math.max(st.w, st.h) : 1;
      last = st.corners;
      let code = "ok", text = "Hold still…";
      if (st.heightFrac < this.o.minFill) { code = "closer"; text = "Move closer: the card should fill most of the frame"; }
      else if (st.tilt.bad) { code = "tilt"; text = "Hold the phone flat, straight above the card"; }
      else if (st.bright < this.o.minBright) { code = "dark"; text = "Too dark: add some light"; }
      else if (st.glare > this.o.maxGlare) { code = "glare"; text = "Glare: tilt the card slightly away from the light"; }
      else if (st.sharp < this.o.minSharp) { code = "blur"; text = "Hold steady, tap the card to focus"; }
      else if (moved > 0.015) { code = "moving"; text = "Hold still…"; }
      if (code !== "ok" && code !== "moving") { goodRun = 0; hint(code, text, false, 0); return; }
      goodRun = code === "ok" ? goodRun + 1 : 0;
      hint(code, goodRun >= holdFrames ? "Got it" : "Hold still…", true, Math.min(1, goodRun / holdFrames));
      if (autoCapture && goodRun >= holdFrames) await capture();
    };
    const loop = async () => {
      if (stopped || busy) return;
      try { await tick(); } catch (e) { onError(e); }
      if (!stopped && !busy) timer = setTimeout(loop, intervalMs);
    };

    (async () => {
      try {
        await this.load(t => hint("loading", t));
        if (!video.srcObject) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false,
            video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
          video.srcObject = stream; video.setAttribute("playsinline", ""); video.muted = true;
          await video.play();
        }
        loop();
      } catch (e) { hint("camera_error", "Camera not available: " + e.message); onError(e); }
    })();
    return ctrl;
  }

  /* ================= Step 1: find, check, straighten ================= */

  async _toCanvas(image, maxSide) {
    if (image instanceof Blob) {
      const url = URL.createObjectURL(image);
      try {
        const img = new Image(); img.src = url; await img.decode();
        return this._toCanvas(img, maxSide);
      } finally { URL.revokeObjectURL(url); }
    }
    const w = image.videoWidth || image.naturalWidth || image.width, h = image.videoHeight || image.naturalHeight || image.height;
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext("2d").drawImage(image, 0, 0, c.width, c.height);
    c.photoScale = s;
    return c;
  }

  _orderCorners(p) {
    const s = p.map(q => q[0] + q[1]), d = p.map(q => q[1] - q[0]);
    const i = a => a.indexOf(Math.min(...a)), j = a => a.indexOf(Math.max(...a));
    return [p[i(s)], p[i(d)], p[j(s)], p[j(d)]];
  }

  _findCorners(src, maxFrac = 0.98, work = WORK) {
    const cv = this.cv;
    const scale = Math.min(1, work / Math.max(src.rows, src.cols));
    const small = new cv.Mat(); cv.resize(src, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    const blur = new cv.Mat(); cv.GaussianBlur(small, blur, new cv.Size(5, 5), 0);
    const gray = new cv.Mat(); cv.cvtColor(blur, gray, cv.COLOR_RGB2GRAY);
    const maps = [];
    const hsv = new cv.Mat(); cv.cvtColor(blur, hsv, cv.COLOR_RGB2HSV);
    const chans = new cv.MatVector(); cv.split(blur, chans); const hs = new cv.MatVector(); cv.split(hsv, hs);
    const ce = cv.Mat.zeros(gray.rows, gray.cols, cv.CV_8U), tmp = new cv.Mat();
    for (const ch of [chans.get(0), chans.get(1), chans.get(2), hs.get(1)]) { cv.Canny(ch, tmp, 20, 60); cv.max(ce, tmp, ce); ch.delete(); }
    const k7 = cv.Mat.ones(7, 7, cv.CV_8U); cv.morphologyEx(ce, ce, cv.MORPH_CLOSE, k7); maps.push(["colour edges", ce]);
    const be = new cv.Mat(); cv.Canny(gray, be, 30, 120); const k5 = cv.Mat.ones(5, 5, cv.CV_8U);
    cv.dilate(be, be, k5, new cv.Point(-1, -1), 2); maps.push(["brightness edges", be]);
    const ot = new cv.Mat(); cv.threshold(gray, ot, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const oti = new cv.Mat(); cv.bitwise_not(ot, oti); maps.push(["light/dark split", ot], ["light/dark split", oti]);
    const area0 = small.rows * small.cols; let best = null, bestArea = 0, method = null;
    for (const [name, em] of maps) {
      const cs = new cv.MatVector(), h = new cv.Mat();
      cv.findContours(em, cs, h, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let n = 0; n < cs.size(); n++) {
        const c = cs.get(n); const a = cv.contourArea(c);
        if (a < .05 * area0 || a > maxFrac * area0 || a <= bestArea) { c.delete(); continue; }
        const r = cv.boundingRect(c);
        const touch = (r.x <= 3) + (r.y <= 3) + (r.x + r.width >= small.cols - 3) + (r.y + r.height >= small.rows - 3);
        if (touch >= 2) { c.delete(); continue; }
        const ap = new cv.Mat(); cv.approxPolyDP(c, ap, .02 * cv.arcLength(c, true), true);
        let pts; const mr = cv.minAreaRect(c);
        if (ap.rows === 4) { pts = []; for (let k = 0; k < 4; k++) pts.push([ap.data32S[k * 2], ap.data32S[k * 2 + 1]]); }
        else {
          if (mr.size.width * mr.size.height > 1.25 * a) { ap.delete(); c.delete(); continue; }
          pts = cv.RotatedRect.points(mr).map(p => [p.x, p.y]);
        }
        const quadArea = Math.abs(pts.reduce((acc, p, k) => { const q = pts[(k + 1) % 4]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
        if (quadArea > maxFrac * area0) { ap.delete(); c.delete(); continue; }
        const [sa, sb] = [mr.size.width, mr.size.height].sort((x, y) => x - y);
        const rr = sb ? sa / sb : 0;
        if (rr > .55 && rr < .85) { best = pts; bestArea = a; method = name; }
        ap.delete(); c.delete();
      }
      cs.delete(); h.delete();
    }
    [small, blur, gray, hsv, tmp, k7, k5, ce, be, ot, oti].forEach(m => m.delete()); chans.delete(); hs.delete();
    if (!best) return null;
    return { corners: this._orderCorners(best.map(([x, y]) => [x / scale, y / scale])), method };
  }

  _findCardAnyZoom(rgb, work = WORK) {
    const cv = this.cv;
    let f = this._findCorners(rgb, 0.98, work); if (f) return f;
    const h = rgb.rows, w = rgb.cols;
    for (const frac of [0.08, 0.2]) for (const col of [255, 0]) {
      const pad = Math.round(frac * Math.max(h, w)), padded = new cv.Mat();
      cv.copyMakeBorder(rgb, padded, pad, pad, pad, pad, cv.BORDER_CONSTANT, new cv.Scalar(col, col, col, 255));
      f = this._findCorners(padded, 0.9 * (h * w) / (padded.rows * padded.cols), work); padded.delete();
      if (f) {
        f.corners = f.corners.map(([x, y]) => [Math.min(w - 1, Math.max(0, x - pad)), Math.min(h - 1, Math.max(0, y - pad))]);
        f.method += " (zoomed out)"; return f;
      }
    }
    const r = Math.min(h, w) / Math.max(h, w);
    if (r > .64 && r < .73) return { corners: [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], method: "whole photo" };
    return null;
  }

  /* Turning the card on the table changes neither number; only tilting the phone does. */
  _tilt([tl, tr, br, bl]) {
    const L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const ang = (p, a, b) => { const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
      return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2))))) * 180 / Math.PI; };
    const off = Math.max(...[[tl, tr, bl], [tr, br, tl], [br, bl, tr], [bl, tl, br]].map(([p, a, b]) => Math.abs(ang(p, a, b) - 90)));
    const r = (a, b) => Math.max(a, b) / Math.min(a, b);
    const ratio = Math.max(r(L(tl, tr), L(bl, br)), r(L(tl, bl), L(tr, br)));
    return { off, ratio, bad: ratio > this.o.maxEdgeRatio || off > this.o.maxCornerOff };
  }

  _cardStats(src, corners) {
    const cv = this.cv, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const [tl, tr, br, bl] = corners;
    let c = corners; if (d(tl, tr) + d(bl, br) > d(tl, bl) + d(tr, br)) c = [tr, br, bl, tl];
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, c.flat()), to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 589, 0, 589, 859, 0, 859]);
    const M = cv.getPerspectiveTransform(from, to), w = new cv.Mat(), g = new cv.Mat(), lap = new cv.Mat(), m = new cv.Mat(), sd = new cv.Mat(), hi = new cv.Mat(), gb = new cv.Mat();
    cv.warpPerspective(src, w, M, new cv.Size(590, 860)); cv.cvtColor(w, g, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(g, gb, new cv.Size(3, 3), 0);
    cv.Laplacian(gb, lap, cv.CV_64F); const bright = cv.mean(g)[0]; cv.meanStdDev(lap, m, sd); const sharp = sd.data64F[0] ** 2;
    cv.threshold(g, hi, 250, 255, cv.THRESH_BINARY); const glare = cv.countNonZero(hi) / (590 * 860) * 100;
    [from, to, M, w, g, lap, m, sd, hi, gb].forEach(x => x.delete());
    const heightPx = Math.max((d(tl, bl) + d(tr, br)) / 2, (d(tl, tr) + d(bl, br)) / 2);
    return { sharp, bright, glare, heightPx };
  }

  _checkPhoto(src, corners, scale = 1) {
    const s = this._cardStats(src, corners), o = this.o, reasons = [];
    if (s.heightPx / scale < o.minCardPx) reasons.push(`Card is small in the photo (${Math.round(s.heightPx / scale)} px tall); move closer.`);
    if (s.bright < o.minBright) reasons.push("Photo is dark; add some light.");
    if (s.sharp < o.minSharp) reasons.push("Photo is blurry; hold steady and tap to focus.");
    if (s.glare > o.maxGlare) reasons.push(`Glare covers ${s.glare.toFixed(1)}% of the card; tilt it slightly away from the light.`);
    return { ...s, reasons };
  }

  _isUpsideDown(card) {
    const cv = this.cv, g = new cv.Mat(); cv.cvtColor(card, g, cv.COLOR_RGBA2GRAY);
    const h = g.rows, w = g.cols;
    const top = g.roi(new cv.Rect(30, Math.round(.04 * h), w - 60, Math.round(.22 * h)));
    const bot = g.roi(new cv.Rect(30, Math.round(.74 * h), w - 60, Math.round(.22 * h)));
    const flip = cv.mean(top)[0] > cv.mean(bot)[0] + 15;
    top.delete(); bot.delete(); g.delete(); return flip;
  }

  /* Straighten onto white, the same 1340 x 1880 image the YOLO model was trained on. */
  _straighten(src, corners) {
    const cv = this.cv;
    let [tl, tr, br, bl] = corners;
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if ((dist(tl, tr) + dist(bl, br)) > (dist(tl, bl) + dist(tr, br))) [tl, tr, br, bl] = [tr, br, bl, tl];
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl, tr, br, bl].flat());
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CARD_W - 1, 0, CARD_W - 1, CARD_H - 1, 0, CARD_H - 1]);
    const M = cv.getPerspectiveTransform(from, to);
    const card = new cv.Mat(); cv.warpPerspective(src, card, M, new cv.Size(CARD_W, CARD_H));
    const flip = this._isUpsideDown(card);
    if (flip) cv.rotate(card, card, cv.ROTATE_180);
    const back = cv.getPerspectiveTransform(to, from), H = Array.from(back.data64F); back.delete();
    const photoPerCard = (dist(tl, bl) + dist(tr, br)) / 2 / CARD_H;
    const out = new cv.Mat(CARD_H + 2 * MARGIN, CARD_W + 2 * MARGIN, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
    const roi = out.roi(new cv.Rect(MARGIN, MARGIN, CARD_W, CARD_H)); card.copyTo(roi); roi.delete();
    const canvas = document.createElement("canvas"); cv.imshow(canvas, out);
    [from, to, M, card, out].forEach(m => m.delete());
    canvas.geom = { H, flip, photoPerCard };
    return canvas;
  }

  /* Cut a box from the original photo at full resolution (up to 4x), lightly sharpened. Real detail, nothing invented. */
  _hiResCrop(src, geom, box) {
    const cv = this.cv, { H, flip, photoPerCard } = geom;
    const toPhoto = ([x, y]) => {
      x -= MARGIN; y -= MARGIN;
      if (flip) { x = CARD_W - 1 - x; y = CARD_H - 1 - y; }
      const w = H[6] * x + H[7] * y + H[8];
      return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    };
    const [x1, y1, x2, y2] = box;
    const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(toPhoto);
    const s = Math.max(1, Math.min(4, photoPerCard));
    const w = Math.max(8, Math.round((x2 - x1) * s)), h = Math.max(8, Math.round((y2 - y1) * s));
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat()), to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
    const M = cv.getPerspectiveTransform(from, to), out = new cv.Mat(), blur = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    cv.GaussianBlur(out, blur, new cv.Size(0, 0), Math.max(0.8, s * 0.6));
    cv.addWeighted(out, 1.6, blur, -0.6, 0, out);
    const c = document.createElement("canvas"); cv.imshow(c, out);
    [from, to, M, out, blur].forEach(m => m.delete());
    c.scale = s;
    return c;
  }

  /* ================= Step 2: YOLO ================= */

  async _detect(card) {
    const ort = this.ort, W = card.width, H = card.height, r = IMGSZ / Math.max(W, H);
    const nw = Math.round(W * r), nh = Math.round(H * r), px = Math.floor((IMGSZ - nw) / 2), py = Math.floor((IMGSZ - nh) / 2);
    const lb = document.createElement("canvas"); lb.width = lb.height = IMGSZ;
    const g = lb.getContext("2d"); g.fillStyle = "rgb(114,114,114)"; g.fillRect(0, 0, IMGSZ, IMGSZ);
    g.drawImage(card, px, py, nw, nh);
    const p = g.getImageData(0, 0, IMGSZ, IMGSZ).data, n = IMGSZ * IMGSZ, input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { input[i] = p[i * 4] / 255; input[n + i] = p[i * 4 + 1] / 255; input[2 * n + i] = p[i * 4 + 2] / 255; }
    const out = (await this.yolo.run({ [this.yolo.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, IMGSZ, IMGSZ]) }))[this.yolo.outputNames[0]];
    const d = out.data, A = out.dims[2], found = {};
    CLASSES.forEach((cls, c) => {
      let bi = -1, bs = 0;
      for (let i = 0; i < A; i++) { const s = d[(4 + c) * A + i]; if (s > bs) { bs = s; bi = i; } }
      if (bi < 0) return;
      const cx = d[bi], cy = d[A + bi], bw = d[2 * A + bi], bh = d[3 * A + bi];
      found[cls] = { conf: bs, box: [(cx - bw / 2 - px) / r, (cy - bh / 2 - py) / r, (cx + bw / 2 - px) / r, (cy + bh / 2 - py) / r]
        .map((v, k) => Math.max(0, Math.min(k % 2 ? H : W, v))) };
    });
    return found;
  }

  /* ================= Step 3: read and match ================= */

  async _recognise(canvas) {
    const ort = this.ort, H = 48, W = Math.max(16, Math.min(1280, Math.round(H * canvas.width / canvas.height)));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, n = W * H, x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) x[ch * n + i] = (px[i * 4 + (2 - ch)] / 255 - 0.5) / 0.5;
    const out = (await this.ocr.run({ [this.ocr.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, H, W]) }))[this.ocr.outputNames[0]];
    const [, T, C] = out.dims, d = out.data; let text = "", last = 0;
    for (let t = 0; t < T; t++) {
      let bi = 0, bv = -Infinity;
      for (let k = 0; k < C; k++) { const v = d[t * C + k]; if (v > bv) { bv = v; bi = k; } }
      if (bi !== last && bi !== 0) text += this.ocrChars[bi] || "";
      last = bi;
    }
    return text.trim();
  }

  /* The crop three ways: as is, extra contrast, and background removed (for foils). */
  _variants(canvas) {
    const cv = this.cv, src = cv.imread(canvas), gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const clahe = new cv.CLAHE(2.5, new cv.Size(4, 4)), ce = new cv.Mat(); clahe.apply(gray, ce);
    const bg = new cv.Mat(); cv.GaussianBlur(gray, bg, new cv.Size(0, 0), 15);
    const flat = new cv.Mat(); cv.subtract(bg, gray, flat); cv.normalize(flat, flat, 0, 255, cv.NORM_MINMAX); cv.bitwise_not(flat, flat);
    const outs = [canvas];
    for (const m of [ce, flat]) { const c = document.createElement("canvas"); cv.imshow(c, m); outs.push(c); }
    [src, gray, ce, bg, flat].forEach(m => m.delete()); clahe.delete();
    return outs;
  }

  async _readAll(canvas) {
    const texts = [];
    for (const v of this._variants(canvas)) { const t = await this._recognise(v); if (t && !texts.includes(t)) texts.push(t); }
    return texts;
  }

  async _read(card, crops) {
    let nameCrop = crops.name;
    if (nameCrop) {   // leave out the attribute symbol at the right end of the name bar
      const c = document.createElement("canvas"); c.width = Math.round(nameCrop.width * 0.9); c.height = nameCrop.height;
      c.getContext("2d").drawImage(nameCrop, 0, 0); nameCrop = c;
    }
    const nameTexts = nameCrop ? await this._readAll(nameCrop) : [];
    let codeTexts = [], codeFrom = "box";
    if (crops.set_code) codeTexts = await this._readAll(crops.set_code);
    else {
      // No box: read the two places a set code is printed (under the art; bottom-left on Pendulums).
      codeFrom = "usual spots";
      for (const [x1, y1, x2, y2] of [[0.60, 0.722, 0.96, 0.752], [0.04, 0.912, 0.36, 0.948]]) {
        const cw = card.width - 2 * MARGIN, ch = card.height - 2 * MARGIN;
        const c = document.createElement("canvas"); c.width = Math.round((x2 - x1) * cw); c.height = Math.round((y2 - y1) * ch);
        c.getContext("2d").drawImage(card, MARGIN + x1 * cw, MARGIN + y1 * ch, c.width, c.height, 0, 0, c.width, c.height);
        for (const t of await this._readAll(c)) if (!codeTexts.includes(t)) codeTexts.push(t);
      }
    }
    return { nameTexts, codeTexts, codeFrom };
  }

  _lev(a, b) {
    let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }
  _sim(a, b) { const m = Math.max(a.length, b.length); return m ? 100 * (1 - this._lev(a, b) / m) : 0; }

  _topK(q, items, keyOf, k, maxLenDiff) {
    const top = [];
    for (const it of items) {
      const key = keyOf(it); if (Math.abs(key.length - q.length) > maxLenDiff) continue;
      const s = this._sim(q, key);
      if (top.length < k || s > top[top.length - 1][0]) { top.push([s, it]); top.sort((a, b) => b[0] - a[0]); if (top.length > k) top.pop(); }
    }
    return top;
  }

  _decide(codeTexts, nameTexts) {
    const codeHits = new Map(), nameHits = new Map();
    for (const t of codeTexts) {
      const q = normCode(t); if (q.length < 5) continue;
      for (const [s, [key, codes]] of this._topK(q, this.codeKeys, e => e[0], 5, 3)) for (const c of codes) codeHits.set(c, Math.max(codeHits.get(c) || 0, s));
    }
    for (const t of nameTexts) {
      const q = normName(t); if (q.length < 3) continue;
      const idx = this.nameNorms.map((_, i) => i);
      for (const [s, i] of this._topK(q, idx, i => this.nameNorms[i], 5, Math.max(4, q.length * 0.5))) nameHits.set(i, Math.max(nameHits.get(i) || 0, s));
    }
    const nameScore = n => Math.max(0, ...nameTexts.map(t => this._sim(normName(t), this.nameNorms[n])));
    const cands = [];
    for (const [code, cs] of [...codeHits].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      const n = this.db.codes[code][0]; cands.push({ n, code, cs, ns: nameScore(n) });
    }
    for (const [n, ns] of [...nameHits].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      if (cands.some(c => c.n === n)) continue;
      let code = null, cs = 0;
      for (const c of this.codesByName.get(n) || []) {
        const s = Math.max(0, ...codeTexts.map(t => this._sim(normCode(t), normCode(c))));
        if (s > cs) { cs = s; code = c; }
      }
      if (cs < 50) { code = null; cs = 0; }
      cands.push({ n, code, cs, ns });
    }
    if (!cands.length) return null;
    // A weak code match (under ~60% alike) says little; a strong one counts as much as the name.
    const score = c => Math.max(0, c.cs - 60) * 2.5 + c.ns;
    cands.sort((a, b) => score(b) - score(a));
    const p = cands[0], otherCs = Math.max(0, ...cands.slice(1).map(c => c.cs));
    let level = "unsure";
    if (p.code && p.cs >= 75 && p.ns >= 70) level = "confirmed";
    else if ((p.code && p.cs >= 85) || p.ns >= 85) level = "likely";
    else if (p.code && p.cs >= 75 && p.cs - otherCs >= 10) level = "likely";
    return { pick: p, level, alts: cands.slice(1, 4) };
  }

  /* ================= Guide helpers ================= */

  _frameState(video) {
    const cv = this.cv;
    if (!this._fc) this._fc = document.createElement("canvas");
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, 960 / Math.max(vw, vh));
    const c = this._fc; c.width = Math.round(vw * s); c.height = Math.round(vh * s);
    c.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height);
    const src = cv.imread(c), rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const found = this._findCardAnyZoom(rgb, 640); rgb.delete();
    const st = { w: c.width, h: c.height, scale: s, corners: null };
    if (found && found.method !== "whole photo") {
      st.corners = found.corners;
      st.tilt = this._tilt(found.corners);
      Object.assign(st, this._cardStats(src, found.corners));
      // How much of the room the card could fill it does fill (1 = edge to edge, either way round).
      const room = Math.max(Math.min(c.height, c.width / 0.686), Math.min(c.width, c.height / 0.686));
      st.heightFrac = st.heightPx / room;
      // The preview is downscaled, so judge sharpness a little more leniently than on the full photo.
      st.sharp *= 1 / Math.max(0.5, s * 1.4);
    }
    src.delete();
    return st;
  }

  _cornerShift(a, b) { return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))); }

  _quickSharpness(canvas) {
    const cv = this.cv, s = Math.min(1, 800 / Math.max(canvas.width, canvas.height));
    const src = cv.imread(canvas), g = new cv.Mat(), lap = new cv.Mat(), m = new cv.Mat(), sd = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY); cv.resize(g, g, new cv.Size(0, 0), s, s, cv.INTER_AREA);
    cv.Laplacian(g, lap, cv.CV_64F); cv.meanStdDev(lap, m, sd); const v = sd.data64F[0] ** 2;
    [src, g, lap, m, sd].forEach(x => x.delete());
    return v;
  }

  /* Draws a card-shaped target and the detected outline (green = good, amber = fix something). */
  _drawGuide(overlay, video, st) {
    const rect = overlay.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(rect.width * dpr); overlay.height = Math.round(rect.height * dpr);
    const g = overlay.getContext("2d"); g.clearRect(0, 0, overlay.width, overlay.height);
    // Map frame coordinates to the overlay, matching the video's object-fit (contain or cover).
    const fit = getComputedStyle(video).objectFit === "cover" ? Math.max : Math.min;
    const k = fit(overlay.width / st.w, overlay.height / st.h);
    const ox = (overlay.width - st.w * k) / 2, oy = (overlay.height - st.h * k) / 2;
    // Target frame: card shape, 85% of the part of the video that is actually on screen.
    const vx = Math.max(0, ox), vy = Math.max(0, oy), vw = Math.min(overlay.width, ox + st.w * k) - vx, vh = Math.min(overlay.height, oy + st.h * k) - vy;
    const th = Math.min(vh * 0.85, vw * 0.85 / 0.686), tw = th * 0.686;
    g.setLineDash([12 * dpr, 10 * dpr]); g.lineWidth = 2 * dpr; g.strokeStyle = "rgba(255,255,255,0.7)";
    g.strokeRect(vx + (vw - tw) / 2, vy + (vh - th) / 2, tw, th); g.setLineDash([]);
    if (!st.corners) return;
    const ok = st.heightFrac >= this.o.minFill && !st.tilt.bad && st.glare <= this.o.maxGlare && st.sharp >= this.o.minSharp && st.bright >= this.o.minBright;
    g.lineWidth = 4 * dpr; g.strokeStyle = ok ? "#2ecc71" : "#f5a623";
    g.beginPath();
    st.corners.forEach(([x, y], i) => { const X = ox + x * k, Y = oy + y * k; i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
    g.closePath(); g.stroke();
  }
}
