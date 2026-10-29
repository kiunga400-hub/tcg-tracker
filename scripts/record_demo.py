"""Record a ~40 s demo of the live site: home -> search suggestions -> card page -> deals -> home.

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


def tour(page: Page, base: str) -> None:
    page.goto(base, wait_until="networkidle")
    page.mouse.move(W / 2, H / 2)
    page.wait_for_timeout(2200)
    scroll(page, 380)                      # deal of the day and stats
    page.wait_for_timeout(1800)
    scroll(page, -380)
    page.wait_for_timeout(600)

    box = page.get_by_role("combobox", name="Search cards").first
    glide(page, box)
    box.press_sequentially("ash blossom", delay=110)
    option = page.get_by_role("option").filter(has_text=CARD).first
    option.wait_for(timeout=15000)
    page.wait_for_timeout(1500)
    glide(page, option)                    # open the card from the suggestions

    page.wait_for_url("**/cards/**", timeout=30000)
    page.get_by_role("table").wait_for(timeout=30000)
    page.wait_for_timeout(2000)
    scroll(page, 420)                      # price table
    page.wait_for_timeout(1200)
    glide(page, page.get_by_text("Cheapest").first, click=False)
    page.wait_for_timeout(1800)
    tabs = page.get_by_role("tab")
    if tabs.count() > 1:
        glide(page, tabs.nth(1))           # switch edition
        page.wait_for_timeout(1600)
    scroll(page, 520)                      # price history chart
    page.wait_for_timeout(2200)

    scroll(page, -1200)
    page.wait_for_timeout(500)
    glide(page, page.get_by_role("link", name="Deals").first)
    page.wait_for_url("**/deals**", timeout=30000)
    page.locator("main ol li").first.wait_for(timeout=30000)
    page.wait_for_timeout(2200)
    scroll(page, 500)
    page.wait_for_timeout(2000)

    glide(page, page.get_by_role("link", name="Card Scout CA").first)
    page.wait_for_url(base.rstrip("/") + "/", timeout=30000)
    page.wait_for_timeout(2500)


def encode(webm: Path, out: Path) -> None:
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    mp4, gif = out / "card-scout-demo.mp4", out / "card-scout-demo.gif"
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(webm), "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-crf", "20", "-movflags", "+faststart", str(mp4)], check=True)
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(webm), "-vf",
                    "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse",
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
        tour(page, args.url)
        video = page.video.path()
        ctx.close()
        browser.close()
    encode(Path(video), out)


if __name__ == "__main__":
    main()
