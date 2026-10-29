import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from scrapy.exceptions import CloseSpider
from scrapy.http import HtmlResponse, Request, TextResponse
from scrapy.utils.test import get_crawler

from tcg_tracker.spiders.games401 import (
    COLLECTION_URL,
    PAGE_SIZE,
    Games401Spider,
    extract_fastsimon_config,
    next_page,
)

DATA = Path(__file__).parent / "data"
FALLBACK = {"uuid": "fallback-uuid", "store_id": "1", "category_id": "2"}
SETTINGS = {"CONTACT_EMAIL": "test@example.com", "GAMES401_FALLBACK_CONFIG": FALLBACK, "GAMES401_MAX_PAGES": 300,
            "GAMES401_COUNT_TOLERANCE": 0.005}
CACHED = {"uuid": "cached-uuid", "store_id": "17041809", "category_id": "281082495163"}


class FakeCache:
    def __init__(self, value=None, age_days=0.0):
        self.stored = (value, age_days * 86400) if value else None
        self.saved = []

    def load(self, key):
        return self.stored

    def save(self, key, value):
        self.saved.append((key, value))


@pytest.fixture
def spider():
    s = Games401Spider.from_crawler(get_crawler(Games401Spider, SETTINGS))
    s.cache = FakeCache()
    return s


def page_html():
    return HtmlResponse(COLLECTION_URL, body=(DATA / "games401_collection_page.html").read_bytes(), encoding="utf-8")


def api_response(request, items, total, pages):
    body = {"uuid": "x", "items": items, "total_results": total, "total_p": pages}
    return TextResponse(request.url, body=json.dumps(body).encode(), encoding="utf-8", request=request)


def rejected_response(request):
    body = {"items": [], "smart_nav_status": False, "uuid": "", "use_personalized_collection": False}
    return TextResponse(request.url, body=json.dumps(body).encode(), encoding="utf-8", request=request)


def items(start, n):
    return [{"id": str(i), "l": f"Card {i}"} for i in range(start, start + n)]


def run(request, response):
    return list(request.callback(response, **request.cb_kwargs))


def test_config_is_read_from_the_real_collection_page():
    cfg = extract_fastsimon_config((DATA / "games401_collection_page.html").read_text(encoding="utf-8"))
    assert cfg == {"uuid": "d3cae9c0-9d9b-4fe3-ad81-873270df14b5", "store_id": "17041809",
                   "category_id": "295545766075"}


def test_api_request_asks_for_in_stock_singles_sorted_by_price(spider):
    req = list(spider._begin(CACHED, "cached"))[0]
    q = {k: v[0] for k, v in parse_qs(urlparse(req.url).query).items()}
    assert (q["UUID"], q["store_id"], q["category_id"]) == ("cached-uuid", "17041809", "281082495163")
    assert q["products_per_page"] == str(PAGE_SIZE) and q["sort_by"] == "price_max_to_min"
    assert json.loads(q["narrow"]) == [["Isp-in-stock", "True"]] and q["page_num"] == "1"


def test_fresh_cache_skips_the_store_page_and_old_cache_reads_it(spider):
    spider.cache = FakeCache(CACHED, age_days=1)
    assert "api.fastsimon.com" in list(spider._initial_requests())[0].url
    s2 = Games401Spider.from_crawler(get_crawler(Games401Spider, SETTINGS))
    s2.cache = FakeCache(CACHED, age_days=9)
    assert list(s2._initial_requests())[0].url == COLLECTION_URL


def test_discovered_config_is_cached(spider):
    out = list(spider.parse_collection(page_html()))
    assert spider.cache.saved[0][0] == "fastsimon" and "UUID=d3cae9c0" in out[0].url
    assert spider.crawler.stats.get_value("401games/config_source") == "discovered"


def test_blocked_page_uses_old_cache_then_fallback(spider, caplog):
    spider.cache = FakeCache(CACHED, age_days=30)
    list(spider._initial_requests())
    assert "UUID=cached-uuid" in list(spider._fallback("429"))[0].url
    s2 = Games401Spider.from_crawler(get_crawler(Games401Spider, SETTINGS))
    s2.cache = FakeCache()
    assert "UUID=fallback-uuid" in list(s2._fallback("429"))[0].url
    assert s2.crawler.stats.get_value("401games/config_source") == "fallback"


def test_rejected_config_rereads_the_page_once_then_fails_if_unchanged(spider):
    spider.cache = FakeCache({"uuid": "d3cae9c0-9d9b-4fe3-ad81-873270df14b5", "store_id": "17041809",
                              "category_id": "295545766075"}, age_days=1)
    first = list(spider._initial_requests())[0]
    out = run(first, rejected_response(first))
    assert out[0].url == COLLECTION_URL and spider.crawler.stats.get_value("401games/config_rejected") == 1
    with pytest.raises(CloseSpider):
        list(spider.parse_collection(page_html()))  # page still has the rejected config
    assert "already rejected" in spider.verdict("failed")


def test_full_paged_crawl(spider):
    req = list(spider._begin(CACHED, "cached"))[0]
    total, pages, got = 600, 3, []
    while req is not None:
        p = req.cb_kwargs["page"]
        out = run(req, api_response(req, items((p - 1) * PAGE_SIZE, min(PAGE_SIZE, total - (p - 1) * PAGE_SIZE)),
                                    total, pages))
        got += [o for o in out if isinstance(o, dict)]
        req = next((o for o in out if isinstance(o, Request)), None)
    assert len(got) == 600 and spider.verdict("finished") is None


def test_empty_page_before_the_end_fails(spider):
    req = list(spider._begin(CACHED, "cached"))[0]
    run(req, api_response(req, items(0, 250), 1000, 4))
    nxt = spider.page_request(2)
    with pytest.raises(CloseSpider):
        run(nxt, api_response(nxt, [], 1000, 4))
    assert "empty_page" in spider.verdict("failed")


def test_price_tie_duplicates_are_skipped_and_counted(spider):
    req = list(spider._begin(CACHED, "cached"))[0]
    out = run(req, api_response(req, items(0, 3) + items(1, 2), 5, 1))
    assert len([o for o in out if isinstance(o, dict)]) == 3
    assert spider.crawler.stats.get_value("401games/duplicate_ids") == 2


def test_page_from_a_disagreeing_index_copy_is_asked_again(spider):
    req = list(spider._begin(CACHED, "cached"))[0]
    run(req, api_response(req, items(0, 250), 35053, 141))  # page 1 sets the total
    p2 = spider.page_request(2)
    out = run(p2, api_response(p2, items(250, 250), 35012, 141))  # other copy: retried, nothing kept
    assert [o.cb_kwargs for o in out] == [{"page": 2, "attempt": 2}] and not [o for o in out if isinstance(o, dict)]
    retry = out[0]
    out = run(retry, api_response(retry, items(250, 250), 35053, 141))  # same copy: kept, moves on to page 3
    assert len([o for o in out if isinstance(o, dict)]) == 250
    assert [o.cb_kwargs["page"] for o in out if isinstance(o, Request)] == [3]
    assert spider.crawler.stats.get_value("401games/page_retries_inconsistent_total") == 1


def test_a_lasting_change_in_total_is_accepted_after_three_tries(spider):
    req = list(spider._begin(CACHED, "cached"))[0]
    run(req, api_response(req, items(0, 250), 35053, 141))
    p2 = spider.page_request(2, attempt=3)
    out = run(p2, api_response(p2, items(250, 250), 35040, 141))
    assert len([o for o in out if isinstance(o, dict)]) == 250 and spider.total == 35040


def test_next_page():
    assert next_page(1, 250, 141, 300) == (2, "more")
    assert next_page(141, 58, 141, 300) == (None, "done")
    assert next_page(5, 0, 141, 300) == (None, "empty_page")
    assert next_page(300, 250, 400, 300) == (None, "too_many_pages")


def crawl_pass(spider, req, served):
    """Answer one pass of page requests; served(page) gives that page's items. Returns the next pass's request."""
    total, pages, got = 1000, 4, []
    while req is not None:
        p = req.cb_kwargs["page"]
        out = run(req, api_response(req, served(p), total, pages))
        got += [o for o in out if isinstance(o, dict)]
        req = next((o for o in out if isinstance(o, Request)), None)
        if req is not None and req.cb_kwargs["page"] == 1:
            return got, req
    return got, None


def test_a_short_crawl_pages_through_again_and_keeps_the_union(spider):
    # first pass: an index swap made page 3 repeat page 2, so 250 cards were never served
    first = {1: items(0, 250), 2: items(250, 250), 3: items(250, 250), 4: items(750, 250)}
    got, again = crawl_pass(spider, list(spider._begin(CACHED, "cached"))[0], first.get)
    assert len(got) == 750 and again is not None and spider.passes == 2
    got2, more = crawl_pass(spider, again, lambda p: items((p - 1) * 250, 250))
    assert len(got2) == 250 and more is None   # only the cards the first pass missed are yielded again
    assert spider.verdict("finished") is None
    assert spider.crawler.stats.get_value("401games/found_by_extra_pass") == 250


def test_still_short_after_the_extra_pass_fails(spider):
    short = {1: items(0, 250), 2: items(250, 250), 3: items(250, 250), 4: items(750, 250)}
    _, again = crawl_pass(spider, list(spider._begin(CACHED, "cached"))[0], short.get)
    _, more = crawl_pass(spider, again, short.get)
    assert more is None and spider.passes == 2   # GAMES401_MAX_PASSES: no third pass
    assert "differs from data.total" in spider.verdict("finished")
