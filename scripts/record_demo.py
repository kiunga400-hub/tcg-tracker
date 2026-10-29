"""Record a ~20 s demo of the live site: home -> search suggestions -> a card at all three stores -> deals.

  python scripts/record_demo.py [--url https://card-scout-silk.vercel.app] [--out demo]

Writes <out>/card-scout-demo.mp4 (H.264, for LinkedIn) and <out>/card-scout-demo.gif (small, for the README).
Needs the dev-only packages playwright and imageio-ffmpeg (`pip install playwright imageio-ffmpeg` then
`python -m playwright install chromium`). The API sleeps on Render's free plan, so it is woken first.
"""
from __future__ import annotations

import argparse
import subprocess
import time
import urllib.request
from pathlib import Path

import imageio_ffmpeg
from playwright.sync_api import Locator, Page, sync_playwright

W, H = 1280, 720
API = "https://card-scout-api.onrender.com/api/stores"
CARD = "RA05-EN091"  # Ash Blossom & Joyous Spring, Ultra Rare: sold at all three stores

# A visible cursor: headless recordings don't draw the mouse.
CURSOR_JS = """
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
    'background:rgba(167,139,250,.55);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.4);' +
    'z-index:2147483647;pointer-events:none;transition:transform .12s';
  document.body.appendChild(c);
  addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => c.style.transform = 'scale(.7)', true);
  addEventListener('mouseup', () => c.style.transform = '', true);
});
"""


def wake_api() -> None:
    for _ in range(3):
        try:
            urllib.request.urlopen(API, timeout=90).read()
            return
        except OSError:
            time.sleep(5)


def glide(page: Page, target: Locator, click: bool = True) -> None:
    target.scroll_into_view_if_needed()
    box = target.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=30)
    page.wait_for_timeout(250)
    if click:
        page.mouse.down()
        page.mouse.up()


def scroll(page: Page, dy: int, steps: int = 12) -> None:
    for _ in range(steps):
        page.mouse.wheel(0, dy / steps)
        page.wait_for_timeout(40)


class Clock:
    """Marks the stretches of the recording spent waiting (page loads, API answers) so encode() can cut them out:
    the finished video shows every page appearing instantly, at normal speed otherwise."""

    def __init__(self) -> None:
        self.t0 = time.monotonic()
        self.cuts: list[tuple[float, float]] = []

    def now(self) -> float:
        return time.monotonic() - self.t0

    def wait(self, fn, keep: float = 0.15) -> None:
        """Run fn (a wait), then mark all but its first `keep` seconds to be cut."""
        a = self.now()
        fn()
        b = self.now()
        if b - a > keep + 0.05:
            self.cuts.append((a + keep, b))


def tour(page: Page, base: str, clock: Clock | None = None) -> None:
    clock = clock or Clock()
    clock.wait(lambda: page.goto(base, wait_until="networkidle"), keep=0)
    clock.wait(lambda: page.wait_for_timeout(400), keep=0)   # first paint settles
    page.mouse.move(W / 2, H / 2)
    page.wait_for_timeout(1200)

    box = page.get_by_role("combobox", name="Search cards").first
    glide(page, box)
    box.press_sequentially("ash blossom", delay=85)
    option = page.get_by_role("option").filter(has_text=CARD).first
    clock.wait(lambda: option.wait_for(timeout=30000))
    page.wait_for_timeout(900)
    glide(page, option)                                       # Ash Blossom RA05-EN091: all three stores

    clock.wait(lambda: (page.wait_for_url("**/cards/**", timeout=30000),
                        page.get_by_role("table").wait_for(timeout=30000),
                        page.locator(".recharts-surface").first.wait_for(timeout=30000)))
    page.wait_for_timeout(1000)                               # a beat on the card
    scroll(page, 380, steps=14)                               # the price table: every store, condition and price
    page.wait_for_timeout(2200)
    scroll(page, 520, steps=18)                               # price history chart
    page.wait_for_timeout(1500)
    scroll(page, 380, steps=14)                               # other printings of the card
    page.wait_for_timeout(1500)
    scroll(page, -1280, steps=20)
    page.wait_for_timeout(300)

    glide(page, page.get_by_role("link", name="Deals").first)
    clock.wait(lambda: (page.wait_for_url("**/deals**", timeout=30000),
                        page.locator("main ol li").first.wait_for(timeout=30000)))
    page.wait_for_timeout(1000)
    scroll(page, 420, steps=14)
    page.wait_for_timeout(1500)


def encode(webm: Path, out: Path, cuts: list[tuple[float, float]]) -> None:
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    # Playwright's webm has a variable frame rate: make it constant first, then drop the waiting stretches
    cut = "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in cuts) or "0"
    trim = f"fps=25,select='not({cut})',setpts=N/25/TB"
    mp4, gif = out / "card-scout-demo.mp4", out / "card-scout-demo.gif"
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(webm), "-vf", trim,
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "20", "-movflags", "+faststart", str(mp4)], check=True)
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(webm), "-vf",
                    f"{trim},fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse",
                    str(gif)], check=True)
    for f in (mp4, gif):
        print(f"{f} ({f.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="https://card-scout-silk.vercel.app")
    ap.add_argument("--out", default="demo")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(exist_ok=True)
    wake_api()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # warm-up pass without recording, so the video doesn't show first-load waits
        warm = browser.new_page(viewport={"width": W, "height": H})
        tour(warm, args.url)
        warm.close()
        ctx = browser.new_context(viewport={"width": W, "height": H}, color_scheme="dark",
                                  record_video_dir=str(out / "raw"), record_video_size={"width": W, "height": H})
        ctx.add_init_script(CURSOR_JS)
        page = ctx.new_page()
        clock = Clock()                                   # the video starts with the page
        tour(page, args.url, clock)
        video = page.video.path()
        ctx.close()
        browser.close()
    encode(Path(video), out, clock.cuts)


if __name__ == "__main__":
    main()
