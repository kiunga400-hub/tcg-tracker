"""Parse raw items and store them in Postgres in batched transactions, with run bookkeeping."""
from __future__ import annotations

import contextlib
import logging
import time

import psycopg
from scrapy import signals

import db
from tcg_tracker.monitoring import FieldStats, run_finished

# The stores crawl in parallel into one database; a batch that deadlocks with another store's is rolled back and redone.
DEADLOCK_RETRIES = 3

logger = logging.getLogger(__name__)


class PostgresPipeline:
    def __init__(self, crawler):
        self.crawler = crawler
        self.database_url = crawler.settings.get("DATABASE_URL")
        self.batch_size = crawler.settings.getint("DB_BATCH_SIZE", 500)
        self.stats = crawler.stats
        self.buffer: list[tuple] = []
        self.saved = 0
        self.with_problems = 0
        self.field_stats = FieldStats()
        self.db_error: str | None = None
        self.conn = None

    @classmethod
    def from_crawler(cls, crawler):
        p = cls(crawler)
        # finish_run needs the close reason, which close_spider doesn't get
        crawler.signals.connect(p.spider_closed, signal=signals.spider_closed)
        return p

    # Scrapy >= 2.14 no longer passes `spider` to pipeline methods; the crawler holds it.
    def open_spider(self, spider=None):
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is not set")
        self.conn = self._connect()
        s = self.crawler.spider.store
        # each spider brings its store's adapter: raw item -> parser.CardRec (shared card identity)
        self.adapter = self.crawler.spider.adapter
        self.store_id = db.ensure_store(self.conn, s["slug"], s["name"], s["base_url"])
        self.run_id = db.start_run(self.conn, self.store_id)
        logger.info("scrape run %s started for store %s", self.run_id, s["slug"])

    def _connect(self):
        # keepalives hold the connection open through quiet stretches (a second 401 pass saves almost nothing)
        return psycopg.connect(self.database_url, autocommit=True, keepalives=1, keepalives_idle=60,
                               keepalives_interval=15, keepalives_count=4)

    def _live_conn(self):
        """The connection, reconnected if the server dropped it while the crawl was quiet. Neon's free plan closes
        idle connections: 401 run 38 (2026-10-30) saved nothing for 35 minutes during its second pass and could not
        close its run, which stayed 'running'."""
        try:
            self.conn.execute("SELECT 1")
        except psycopg.OperationalError:
            logger.warning("database connection was dropped; reconnecting")
            self.stats.inc_value("tcg/db_reconnects")
            with contextlib.suppress(psycopg.Error):
                self.conn.close()
            self.conn = self._connect()
        return self.conn

    def process_item(self, item, spider=None):
        if self.db_error:
            return item
        raw = item["raw"]
        try:
            rec = self.adapter(raw)
        except Exception:
            # a crash is a parser bug, not a data gap: count it loudly so monitoring sees it
            logger.exception("adapter crashed on product %s", raw.get("id"))
            self.stats.inc_value("tcg/parse_exceptions")
            return item
        if rec.problems:
            self.with_problems += 1
            self.stats.inc_value("tcg/items_with_problems")
        self.field_stats.add(rec)
        self.buffer.append((rec, raw))
        if len(self.buffer) >= self.batch_size:
            self._flush()
        return item

    def _flush(self):
        if not self.buffer or self.db_error:
            return
        for attempt in range(1, DEADLOCK_RETRIES + 1):
            try:
                conn = self._live_conn()
                with conn.transaction():
                    db.save_items(conn, self.store_id, self.run_id, self.buffer)
                break
            except psycopg.errors.DeadlockDetected as e:
                # another store's crawl held the same cards; the batch rolled back whole, so it is safe to redo
                if attempt == DEADLOCK_RETRIES:
                    return self._db_failed(e)
                self.stats.inc_value("tcg/deadlock_retries")
                logger.warning("deadlock saving a batch (attempt %d), retrying", attempt)
                time.sleep(attempt)
            except psycopg.Error as e:
                return self._db_failed(e)
        self.saved += len(self.buffer)
        self.stats.set_value("tcg/items_saved", self.saved)
        self.buffer.clear()

    def _db_failed(self, e: psycopg.Error):
        self.db_error = f"database error while saving a batch: {e!r}"
        logger.error(self.db_error)
        self.crawler.engine.close_spider(self.crawler.spider, "db_error")

    def close_spider(self, spider=None):
        self._flush()

    def spider_closed(self, spider, reason):
        if self.conn is None:
            return
        error = self.db_error or spider.verdict(reason)
        field_stats = self.field_stats.as_dict()
        try:
            conn = self._live_conn()
            with conn.transaction():
                status, notes = db.finish_run(conn, self.store_id, self.run_id, self.saved,
                                              self.with_problems, error=error, field_stats=field_stats,
                                              misses_to_confirm=getattr(spider, "misses_to_confirm", 1))
        finally:
            self.conn.close()
        self.stats.set_value("tcg/run_status", status)
        log = logger.info if status == "ok" else logger.error
        log("scrape run %s finished: %s (%s items, %s with problems)%s", self.run_id, status, self.saved,
            self.with_problems, f" - {notes}" if notes else "")
        self.crawler.signals.send_catch_log(
            run_finished, run_id=self.run_id, store_id=self.store_id, status=status, notes=notes,
            items_seen=self.saved, items_with_problems=self.with_problems, field_stats=field_stats)
