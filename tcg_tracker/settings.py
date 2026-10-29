"""Scrapy settings. Anything deployment-specific comes from the environment (see .env.example)."""
import os

BOT_NAME = "tcg_tracker"
SPIDER_MODULES = ["tcg_tracker.spiders"]
NEWSPIDER_MODULE = "tcg_tracker.spiders"

# Politeness: identify ourselves with a contact address, one request at a time, a couple of runs per day.
CONTACT_EMAIL = os.environ.get("TCG_CONTACT_EMAIL", "")
USER_AGENT = f"tcg-tracker/0.1 (Canadian Yu-Gi-Oh price tracker; contact: {CONTACT_EMAIL or 'unset'})"
ROBOTSTXT_OBEY = True
CONCURRENT_REQUESTS = 1
CONCURRENT_REQUESTS_PER_DOMAIN = 1
DOWNLOAD_DELAY = 0.5
AUTOTHROTTLE_ENABLED = True
AUTOTHROTTLE_START_DELAY = 0.5
AUTOTHROTTLE_MAX_DELAY = 30
AUTOTHROTTLE_TARGET_CONCURRENCY = 1.0
COOKIES_ENABLED = False

RETRY_ENABLED = True
RETRY_TIMES = 3
RETRY_HTTP_CODES = [429, 500, 502, 503, 504, 522, 524, 408]
DOWNLOADER_MIDDLEWARES = {
    # runs before RetryMiddleware (550) on the way back, so the retry happens after the wait
    "tcg_tracker.middlewares.RetryAfterMiddleware": 560,
    # off unless a spider sets ADAPTIVE_DELAY_ENABLED (see middlewares.AdaptiveDelayMiddleware)
    "tcg_tracker.middlewares.AdaptiveDelayMiddleware": 570,
}

ITEM_PIPELINES = {
    "tcg_tracker.pipelines.PostgresPipeline": 300,
}
DATABASE_URL = os.environ.get("DATABASE_URL", "")
DB_BATCH_SIZE = 500

# Trinity Hobby (Hotyon "Ultimate Search & Filter"). The API key is discovered from the collection page every run;
# this public frontend key is only a last-resort fallback and using it logs a loud warning.
TRINITY_FALLBACK_API_KEY = os.environ.get("TRINITY_FALLBACK_API_KEY", "04572457-312a-4a58-b5e9-6aff246ee39f")
# The discovered key is cached in store_config; the store page (which rate-limits bots) is re-read only after this
# many days, or immediately if the API rejects the cached key.
TRINITY_API_KEY_MAX_AGE_DAYS = 7
TRINITY_MAX_PAGES = 100
TRINITY_COUNT_TOLERANCE = 0.005  # fail the run if the item count is off data.total by more than 0.5%

# Monitoring (tcg_tracker/monitoring.py). Alerts always go to the log and scrape_runs.alerts; Discord and email are
# used when configured.
EXTENSIONS = {"tcg_tracker.monitoring.RunMonitor": 500}
MONITOR_ENABLED = os.environ.get("MONITOR_ENABLED", "1") != "0"
MONITOR_MIN_ITEM_RATIO = 0.9        # items_seen vs the last good run
MONITOR_MAX_PROBLEM_RATE = 0.02     # share of items with parse problems (real crawl: 0.65%)
MONITOR_NULL_RATE_JUMP = 0.02       # absolute rise in a field's NULL share vs the last good run
MONITOR_MAX_HTTP_ERROR_RATE = 0.05  # non-2xx responses + download exceptions / all downloads
ALERT_DISCORD_WEBHOOK_URL = os.environ.get("ALERT_DISCORD_WEBHOOK_URL", "")
ALERT_EMAIL_TO = os.environ.get("ALERT_EMAIL_TO", "")
ALERT_EMAIL_FROM = os.environ.get("ALERT_EMAIL_FROM", "")
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_STARTTLS = os.environ.get("SMTP_STARTTLS", "1") != "0"

# 401 Games (Fast Simon). Config is discovered from the collection page and cached in store_config; this public
# frontend config is only a last-resort fallback and using it logs a loud warning.
GAMES401_FALLBACK_CONFIG = {"uuid": "d3cae9c0-9d9b-4fe3-ad81-873270df14b5", "store_id": "17041809",
                            "category_id": "281082495163"}
GAMES401_CONFIG_MAX_AGE_DAYS = 7
GAMES401_MAX_PAGES = 300
GAMES401_PAGE_ATTEMPTS = 3        # re-ask a page whose total disagrees with page 1 (inconsistent index copies)
GAMES401_COUNT_TOLERANCE = 0.02     # index drift skips ~0.7% per crawl; misses_to_confirm = 2 guards stock
GAMES401_MAX_PASSES = 2            # a crawl that ends short pages through once more (union of both passes)

# Fusion Gaming (Shopify products.json; no API key)
FUSION_MAX_PAGES = 100            # 56 pages of 250 on 2026-10-26
FUSION_COUNT_TOLERANCE = 0.01     # products_count includes ~0.3% the feed doesn't list

# Hobbiesville (Shopify products.json, same crawl as Fusion)
HOBBIESVILLE_MAX_PAGES = 60        # 17 pages of 250 on 2026-10-26
HOBBIESVILLE_COUNT_TOLERANCE = 0.01  # products_count 4,239 vs 4,233 listed (0.14%)

TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"
FEED_EXPORT_ENCODING = "utf-8"
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
