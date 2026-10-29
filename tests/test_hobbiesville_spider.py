"""Hobbiesville reuses FusionSpider's Shopify crawl; these check it runs against its own store and settings."""
import json

import pytest
from scrapy.exceptions import CloseSpider
from scrapy.http import Request, TextResponse
from scrapy.utils.test import get_crawler

from tcg_tracker.spiders.hobbiesville import COLLECTION, HobbiesvilleSpider

SETTINGS = {"CONTACT_EMAIL": "test@example.com", "HOBBIESVILLE_MAX_PAGES": 3, "HOBBIESVILLE_COUNT_TOLERANCE": 0.01}


def spider():
    return HobbiesvilleSpider.from_crawler(get_crawler(HobbiesvilleSpider, SETTINGS))


def respond(req, body):
    return list(req.callback(TextResponse(req.url, body=json.dumps(body).encode(), encoding="utf-8", request=req),
                             **req.cb_kwargs))


def test_crawls_its_own_collection_and_counts_against_products_count():
    s = spider()
    req = Request(f"{COLLECTION}.json", callback=s.parse_collection)
    page1 = respond(req, {"collection": {"products_count": 4239}})[0]
    assert page1.url == f"{COLLECTION}/products.json?limit=250&page=1"
    out = respond(page1, {"products": [{"id": i} for i in range(4233)]})  # the real 0.14% gap
    respond(out[-1], {"products": []})
    assert s.verdict("finished") is None
    assert s.store["slug"] == "hobbiesville" and s.adapter.__module__ == "adapter_hobbiesville"


def test_uses_its_own_page_cap():
    s = spider()
    s.total = 10 ** 6
    with pytest.raises(CloseSpider):
        respond(s.page_request(3), {"products": [{"id": 1}]})
    assert "more than 3 pages" in s.failure


def test_paced_but_faster_than_fusion():
    c = HobbiesvilleSpider.custom_settings
    assert c["DOWNLOAD_DELAY"] == 5.0 and c["RETRY_TIMES"] >= 15 and c["CLOSESPIDER_TIMEOUT"] <= 6000


def test_requests_ask_for_the_canadian_market():
    # from a US server Shopify otherwise answers with US-market prices (2026-10-27)
    s = spider()
    assert s.page_request(1).headers.get("Cookie") == b"localization=CA; cart_currency=CAD"
