"""401 Games (store.401games.ca, Toronto) Yu-Gi-Oh singles via the Fast Simon search API.

Flow: Fast Simon config -> categories_navigation pages of 250 (in-stock singles, price high->low) until total_p.
Same contract as the Trinity spider: completeness checks, and a verdict the pipeline turns into the run status.

Fast Simon config {"uuid", "store_id", "category_id"}, in order of preference:
  1. cached in store_config and younger than GAMES401_CONFIG_MAX_AGE_DAYS (the store's own pages answer bots with 429);
  2. read from the collection page (UUID / store_id in the Fast Simon script URL, category = the collection's
     Shopify resourceId), then cached;
  3. if the page can't be read: the cached config even if old (warning);
  4. last resort: GAMES401_FALLBACK_CONFIG (error).
A config Fast Simon doesn't accept comes back as HTTP 200 with no total_results and uuid "": the page is read once more.
"""
from __future__ import annotations

import json
import re
from urllib.parse import urlencode

import scrapy
from scrapy.exceptions import CloseSpider

import adapter_401
from tcg_tracker.config_cache import StoreConfigCache
from tcg_tracker.spiders.trinity import count_problem

STORE = {"slug": "401games", "name": "401 Games", "base_url": "https://store.401games.ca"}
COLLECTION_URL = "https://store.401games.ca/collections/yugioh-singles"
API_URL = "https://api.fastsimon.com/categories_navigation"
PAGE_SIZE = 250   # largest size tested (2026-10-26); 141 pages for ~35,000 in-stock singles
CONFIG_KEY = "fastsimon"

UUID_RE = re.compile(r"UUID=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.I)
STORE_ID_RE = re.compile(r"store_id=(\d+)")
RESOURCE_RE = re.compile(r'"resourceId":\s*(\d+)')


def extract_fastsimon_config(html: str) -> dict | None:
    """{"uuid", "store_id", "category_id"} from a 401 collection page, or None if any is missing."""
    u, s, c = UUID_RE.search(html), STORE_ID_RE.search(html), RESOURCE_RE.search(html)
    if not (u and s and c):
        return None
    return {"uuid": u.group(1).lower(), "store_id": s.group(1), "category_id": c.group(1)}


def next_page(page: int, n_items: int, total_pages: int, max_pages: int) -> tuple[int | None, str]:
    """What to fetch after page `page` (1-based). Returns (next page or None, reason)."""
    if page >= total_pages:
        return None, "done"
    if n_items == 0:
        return None, "empty_page"
    if page >= max_pages:
        return None, "too_many_pages"
    return page + 1, "more"


class Games401Spider(scrapy.Spider):
    name = "401games"
    store = STORE
    adapter = staticmethod(adapter_401.parse_item)  # raw Fast Simon item -> CardRec
    # Fast Simon's index copies disagree, so ~0.7% of cards are skipped per crawl (2026-10-26). A card is only out of
    # stock after two complete runs in a row miss it; real sell-outs are confirmed one run (~12 h) later.
    misses_to_confirm = 2

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.seen_ids: set[str] = set()
        self.total: int | None = None
        self.pages = 0
        self.passes = 1
        self.failure: str | None = None
        self.cache = None
        self.stale: dict | None = None
        self.rejected: list[dict] = []

    @classmethod
    def from_crawler(cls, crawler, *args, **kwargs):
        spider = super().from_crawler(crawler, *args, **kwargs)
        spider.cache = StoreConfigCache(crawler.settings.get("DATABASE_URL", ""), STORE)
        return spider

    @property
    def _settings(self):
        return self.crawler.settings

    async def start(self):
        if not self._settings.get("CONTACT_EMAIL"):
            raise CloseSpider("TCG_CONTACT_EMAIL is not set; the User-Agent must carry a contact address")
        for request in self._initial_requests():
            yield request

    # --- Fast Simon config: cache, discovery, fallbacks ------------------------------------------------------
    def _initial_requests(self):
        cached = self.cache.load(CONFIG_KEY) if self.cache else None
        max_age = self._settings.getfloat("GAMES401_CONFIG_MAX_AGE_DAYS", 7) * 86400
        if cached and cached[0].get("uuid"):
            cfg, age = cached
            if age < max_age:
                self.logger.info("using cached Fast Simon config (%.1f days old); not fetching the store page",
                                 age / 86400)
                yield from self._begin(cfg, "cached")
                return
            self.stale = cfg
        yield self._collection_request()

    def _collection_request(self) -> scrapy.Request:
        return scrapy.Request(COLLECTION_URL, callback=self.parse_collection, errback=self.collection_failed,
                              dont_filter=True)

    def parse_collection(self, response):
        cfg = extract_fastsimon_config(response.text)
        if cfg:
            if self.cache:
                self.cache.save(CONFIG_KEY, cfg)
            yield from self._begin(cfg, "discovered")
        else:
            yield from self._fallback(f"Fast Simon config not found in {response.url}")

    def collection_failed(self, failure):
        yield from self._fallback(f"collection page failed: {failure.value!r}")

    def _fallback(self, why: str):
        if self.stale:
            self.logger.warning("%s. Using the cached Fast Simon config even though it is older than the limit.", why)
            cfg, self.stale = self.stale, None
            yield from self._begin(cfg, "cached_stale")
            return
        self.logger.error("!!! %s. Using the hardcoded fallback Fast Simon config; check the page.", why)
        yield from self._begin(dict(self._settings.getdict("GAMES401_FALLBACK_CONFIG")), "fallback")

    def _begin(self, cfg: dict, source: str):
        if cfg in self.rejected:
            self._fail(f"Fast Simon config from {source} was already rejected and no other is available")
        self.crawler.stats.set_value("401games/config_source", source)
        self.cfg = cfg
        yield self.page_request(1)

    # --- paging -----------------------------------------------------------------------------------------------
    def page_request(self, page: int, attempt: int = 1) -> scrapy.Request:
        # in-stock singles only; price high->low gives a stable order for paging
        params = {"UUID": self.cfg["uuid"], "store_id": self.cfg["store_id"], "category_id": self.cfg["category_id"],
                  "api_type": "json", "facets_required": 0, "with_product_attributes": "true",
                  "products_per_page": PAGE_SIZE, "page_num": page, "sort_by": "price_max_to_min",
                  "narrow": json.dumps([["Isp-in-stock", "True"]])}
        return scrapy.Request(f"{API_URL}?{urlencode(params)}", callback=self.parse_page, errback=self.page_failed,
                              cb_kwargs={"page": page, "attempt": attempt}, dont_filter=True)

    def parse_page(self, response, page: int, attempt: int = 1):
        try:
            data = response.json()
            items = data["items"]
        except (ValueError, KeyError, TypeError) as e:
            self._fail(f"unexpected API response on page {page}: {e!r}")
        if "total_results" not in data:
            if page == 1:
                # Fast Simon's answer to a config it doesn't know: re-read the collection page once
                self.rejected.append(self.cfg)
                self.stale = None
                self.crawler.stats.inc_value("401games/config_rejected")
                self.logger.warning("Fast Simon did not accept the config (no total_results); re-reading the page")
                yield self._collection_request()
                return
            self._fail(f"API page {page} has no total_results")
        total, total_pages = int(data["total_results"]), int(data.get("total_p") or 0)
        if self.total is not None and total != self.total:
            # Fast Simon answers from index copies that disagree (2026-10-26: total flipped 35,012 <-> 35,053 21 times
            # in one crawl, giving 335 duplicates and 335 misses). Ask again for a page from the same copy as the
            # rest; after MAX_PAGE_ATTEMPTS accept it as a real change in stock.
            if attempt < self._settings.getint("GAMES401_PAGE_ATTEMPTS", 3):
                self.crawler.stats.inc_value("401games/page_retries_inconsistent_total")
                yield self.page_request(page, attempt + 1)
                return
            self.logger.warning("total_results changed mid-crawl: %s -> %s", self.total, total)
        self.pages += 1
        self.total = total

        for raw in items:
            if raw.get("id") in self.seen_ids:
                # first pass: shifting index copies move cards across page boundaries; the count check catches gaps.
                # later passes: almost everything is already seen, which is the point
                if self.passes == 1:
                    self.crawler.stats.inc_value("401games/duplicate_ids")
                continue
            self.seen_ids.add(raw.get("id"))
            if self.passes > 1:
                self.crawler.stats.inc_value("401games/found_by_extra_pass")
            yield {"raw": raw}

        nxt, why = next_page(page, len(items), total_pages, self._settings.getint("GAMES401_MAX_PAGES"))
        if nxt is not None:
            yield self.page_request(nxt)
        elif why != "done":
            self._fail(f"paging stopped early ({why}) at page {page}, {len(self.seen_ids)}/{total} items")
        elif self._short() and self.passes < self._settings.getint("GAMES401_MAX_PASSES", 2):
            # Fast Simon swapped index copies mid-crawl and pages skipped cards (2026-10-28/29: 2.1% and 6.1% short).
            # Page through once more and keep the union: a card skipped on one pass is almost always on the other.
            self.passes += 1
            self.crawler.stats.set_value("401games/passes", self.passes)
            self.logger.warning("pass %d ended short (%s); paging through again", self.passes - 1, self._short())
            yield self.page_request(1)

    def page_failed(self, failure):
        self._fail(f"page request failed after retries: {failure.request.url} {failure.value!r}")

    def _fail(self, reason: str):
        self.failure = self.failure or reason
        self.logger.error("Run failed: %s", reason)
        raise CloseSpider("failed")

    def _short(self) -> str | None:
        """Why the cards seen so far don't add up to the API's total, or None if they do."""
        return count_problem(len(self.seen_ids), self.total, self._settings.getfloat("GAMES401_COUNT_TOLERANCE"))

    def verdict(self, close_reason: str) -> str | None:
        """None if the crawl is complete and trustworthy, else the reason it isn't."""
        if self.failure:
            return self.failure
        if close_reason != "finished":
            return f"spider closed early: {close_reason}"
        return self._short()
