"""PostgresPipeline bookkeeping with the database calls replaced by recorders (no Postgres needed)."""
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from scrapy.utils.test import get_crawler

import tcg_tracker.pipelines as pl
from tcg_tracker.spiders.trinity import TrinitySpider


class FakeConn:
    def __init__(self):
        self.closed = False

    def transaction(self):
        return nullcontext()

    def close(self):
        self.closed = True


@pytest.fixture
def calls(monkeypatch):
    rec = SimpleNamespace(saved=[], finished=None)
    monkeypatch.setattr(pl.psycopg, "connect", lambda *a, **k: FakeConn())
    monkeypatch.setattr(pl.db, "ensure_store", lambda conn, slug, name, url: 1)
    monkeypatch.setattr(pl.db, "start_run", lambda conn, store_id: 7)
    monkeypatch.setattr(pl.db, "save_items",
                        lambda conn, store_id, run_id, pairs: rec.saved.extend(r.product_id for r, _ in pairs))

    def finish(conn, store_id, run_id, seen, problems, error=None, field_stats=None, misses_to_confirm=1):
        rec.finished = (seen, problems, error)
        rec.field_stats = field_stats
        return ("failed" if error else "ok"), error

    monkeypatch.setattr(pl.db, "finish_run", finish)
    return rec


def make_pipeline(batch=2):
    crawler = get_crawler(TrinitySpider, {"DATABASE_URL": "postgresql://fake", "DB_BATCH_SIZE": batch,
                                          "CONTACT_EMAIL": "t@example.com", "TRINITY_COUNT_TOLERANCE": 0.005})
    crawler.spider = TrinitySpider.from_crawler(crawler)
    return pl.PostgresPipeline.from_crawler(crawler), crawler.spider


def raw(i, title="Therion Cross [DIFO-EN070] Super Rare"):
    return {"id": i, "urlName": "x", "title": title, "tags": ["Super Rare", "YGO_Dimension Force", "1st Edition"],
            "options": [{"name": "Title", "values": ["Near Mint 1st Edition"]}],
            "variants": [{"id": i * 10, "sku": None, "available": 1, "price": 1.0, "options": [0]}]}


def test_items_are_saved_in_batches_and_run_finishes_ok(calls):
    p, spider = make_pipeline(batch=2)
    p.open_spider()
    for i in range(5):
        p.process_item({"raw": raw(i)})
    assert calls.saved == [0, 1, 2, 3]  # last item still buffered
    p.close_spider()
    spider.total, spider.seen_ids = 5, set(range(5))
    p.spider_closed(spider, "finished")
    assert calls.saved == [0, 1, 2, 3, 4] and calls.finished == (5, 0, None) and p.conn.closed
    assert calls.field_stats["n_listings"] == 5 and calls.field_stats["card_key"] == 0.0


def test_run_finished_signal_carries_the_run(calls):
    from tcg_tracker.monitoring import run_finished

    p, spider = make_pipeline()
    got = []
    p.crawler.signals.connect(lambda **kw: got.append(kw), signal=run_finished, weak=False)
    p.open_spider()
    p.process_item({"raw": raw(1)})
    p.close_spider()
    spider.total, spider.seen_ids = 1, {1}
    p.spider_closed(spider, "finished")
    assert got and got[0]["run_id"] == 7 and got[0]["status"] == "ok" and got[0]["items_seen"] == 1


def test_incomplete_crawl_is_reported_as_failed(calls):
    p, spider = make_pipeline()
    p.open_spider()
    p.process_item({"raw": raw(1)})
    p.close_spider()
    spider.total, spider.seen_ids = 11793, {1}
    p.spider_closed(spider, "finished")
    assert calls.finished[2] and "differs from data.total" in calls.finished[2]


def test_problem_items_are_counted_and_still_saved(calls):
    p, spider = make_pipeline()
    p.open_spider()
    p.process_item({"raw": raw(1, title="Mystery card with no code")})
    p.close_spider()
    spider.total, spider.seen_ids = 1, {1}
    p.spider_closed(spider, "finished")
    assert calls.saved == [1] and calls.finished == (1, 1, None)


def test_missing_database_url_fails_loudly():
    crawler = get_crawler(TrinitySpider, {"DATABASE_URL": ""})
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        pl.PostgresPipeline.from_crawler(crawler).open_spider()


def test_a_deadlocked_batch_is_retried(calls, monkeypatch):
    # stores crawl in parallel and share cards; a deadlock rolls the batch back whole, so it can be redone
    attempts = []
    real = pl.db.save_items

    def flaky(conn, store_id, run_id, pairs):
        attempts.append(1)
        if len(attempts) == 1:
            raise pl.psycopg.errors.DeadlockDetected("deadlock detected")
        real(conn, store_id, run_id, pairs)

    monkeypatch.setattr(pl.db, "save_items", flaky)
    monkeypatch.setattr(pl.time, "sleep", lambda s: None)
    pipe, _ = make_pipeline(batch=2)
    pipe.open_spider()
    for i in (1, 2):
        pipe.process_item({"raw": raw(i)})
    assert len(attempts) == 2 and calls.saved == [1, 2] and pipe.db_error is None
