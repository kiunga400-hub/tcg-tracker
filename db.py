"""Persistence layer: upsert parsed items, track changes, close out a run."""
from __future__ import annotations

from psycopg.types.json import Jsonb

# A run that returns fewer items than this share of the previous good run is not trusted.
MIN_RATIO = 0.9

# Per-connection staging tables. A batch is COPYed in, then merged with a few set-based statements
# (was ~3 queries per variant: 60s for the 62,710-variant fixture, now a handful per batch).
_STAGE_DDL = """
CREATE TEMP TABLE IF NOT EXISTS stage_listings (
    source_product_id bigint, card_key text, url_name text, title_raw text, problems text[], raw jsonb,
    image_url text);
CREATE TEMP TABLE IF NOT EXISTS stage_variants (
    source_product_id bigint, source_variant_id bigint, sku text, condition text, edition text,
    price numeric(10,2), quantity integer, in_stock boolean);
TRUNCATE stage_listings, stage_variants;
"""

_UPSERT_LISTINGS = """
INSERT INTO listings (store_id, source_product_id, card_key, url_name, title_raw, problems, in_stock, last_run_id, raw,
                      image_url)
SELECT %(store)s, source_product_id, card_key, url_name, title_raw, problems, true, %(run)s, raw, image_url
FROM stage_listings
ON CONFLICT (store_id, source_product_id) DO UPDATE SET
   card_key = EXCLUDED.card_key, url_name = EXCLUDED.url_name, title_raw = EXCLUDED.title_raw,
   problems = EXCLUDED.problems, in_stock = true, last_seen = now(), missed_runs = 0,
   last_run_id = EXCLUDED.last_run_id, raw = EXCLUDED.raw, image_url = EXCLUDED.image_url
"""

# One statement so `old` reads the pre-update values: a history row only when something observable changed
# (or on first sight).
_UPSERT_VARIANTS = """
WITH incoming AS (
    SELECT l.id AS listing_id, s.source_variant_id, s.sku, s.condition, s.edition, s.price, s.quantity, s.in_stock
    FROM stage_variants s JOIN listings l ON l.store_id = %(store)s AND l.source_product_id = s.source_product_id
), old AS (
    SELECT v.id, v.price, v.quantity, v.in_stock
    FROM variants v JOIN incoming i USING (listing_id, source_variant_id)
), up AS (
    INSERT INTO variants (listing_id, source_variant_id, sku, condition, edition, price, quantity, in_stock,
                          last_run_id)
    SELECT listing_id, source_variant_id, sku, condition, edition, price, quantity, in_stock, %(run)s FROM incoming
    ON CONFLICT (listing_id, source_variant_id) DO UPDATE SET
       sku = EXCLUDED.sku, condition = EXCLUDED.condition, edition = EXCLUDED.edition,
       last_seen = now(), last_run_id = EXCLUDED.last_run_id,
       price = EXCLUDED.price, quantity = EXCLUDED.quantity, in_stock = EXCLUDED.in_stock
    RETURNING id, price, quantity, in_stock
)
INSERT INTO price_history (variant_id, price, quantity, in_stock, source)
SELECT up.id, up.price, up.quantity, up.in_stock, 'seen' FROM up LEFT JOIN old ON old.id = up.id
WHERE old.id IS NULL OR (old.price, old.quantity, old.in_stock) IS DISTINCT FROM (up.price, up.quantity, up.in_stock)
ON CONFLICT DO NOTHING
"""


def ensure_store(conn, slug, name, base_url):
    return conn.execute(
        """INSERT INTO stores (slug, name, base_url) VALUES (%s,%s,%s)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id""",
        (slug, name, base_url)).fetchone()[0]


def get_store_config(conn, store_id, key):
    """(value, age in seconds) for a cached store setting, or None."""
    row = conn.execute(
        """SELECT value, extract(epoch FROM now() - updated_at) FROM store_config
           WHERE store_id=%s AND key=%s""", (store_id, key)).fetchone()
    return (row[0], float(row[1])) if row else None


def set_store_config(conn, store_id, key, value):
    conn.execute(
        """INSERT INTO store_config (store_id, key, value) VALUES (%s,%s,%s)
           ON CONFLICT (store_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
        (store_id, key, Jsonb(value)))


def start_run(conn, store_id):
    return conn.execute("INSERT INTO scrape_runs (store_id) VALUES (%s) RETURNING id", (store_id,)).fetchone()[0]


def save_items(conn, store_id, run_id, pairs):
    """Upsert a batch of (CardRec from parser.py, raw payload). Call inside a transaction."""
    # the same product twice in one statement would be an error; the last copy wins
    latest = {rec.product_id: (rec, raw) for rec, raw in pairs}
    if not latest:
        return
    conn.execute(_STAGE_DDL)
    cards = {}
    for rec, _ in latest.values():
        # keep the first copy of each card, but prefer one that knows its set name
        if rec.card_key and (rec.card_key not in cards or (cards[rec.card_key][4] is None and rec.set_name)):
            cards[rec.card_key] = (rec.card_key, rec.set_code, rec.card_number, rec.name, rec.set_name,
                                   rec.rarity, rec.art_label)
    with conn.cursor() as cur:
        if cards:
            # a card first seen at a store without set names (Fusion) gets one when another store has it
            cur.executemany(
                """INSERT INTO cards (card_key,set_code,card_number,name,set_name,rarity,art_label)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (card_key) DO UPDATE SET set_name = EXCLUDED.set_name
                   WHERE cards.set_name IS NULL AND EXCLUDED.set_name IS NOT NULL""",
                # in card_key order: stores crawl at the same time and share cards, and locking the same rows in
                # different orders deadlocked two crawls (2026-10-29, Hobbiesville run 32)
                [cards[k] for k in sorted(cards)])
        with cur.copy("COPY stage_listings (source_product_id, card_key, url_name, title_raw, problems, raw,"
                      " image_url) FROM STDIN") as cp:
            for rec, raw in latest.values():
                cp.write_row((rec.product_id, rec.card_key, rec.url_name, rec.title or raw.get("title", ""),
                              rec.problems, Jsonb(raw), rec.image_url))
        with cur.copy("COPY stage_variants (source_product_id, source_variant_id, sku, condition, edition, price,"
                      " quantity, in_stock) FROM STDIN") as cp:
            for rec, _ in latest.values():
                seen = set()
                for v in rec.variants:
                    if v.variant_id not in seen:
                        seen.add(v.variant_id)
                        cp.write_row((rec.product_id, v.variant_id, v.sku, v.condition, v.edition, v.price,
                                      v.quantity, v.in_stock))
        params = {"store": store_id, "run": run_id}
        cur.execute(_UPSERT_LISTINGS, params)
        cur.execute(_UPSERT_VARIANTS, params)


def save_item(conn, store_id, run_id, rec, raw):
    """Upsert one parsed card with its raw payload (convenience wrapper around save_items)."""
    save_items(conn, store_id, run_id, [(rec, raw)])


def finish_run(conn, store_id, run_id, items_seen, items_with_problems, error=None, field_stats=None,
               misses_to_confirm=1):
    """Close the run. Only a trustworthy run is allowed to mark missing cards out of stock.

    error: set by the caller when the crawl itself was incomplete (paging stopped, count mismatch, DB error).
    field_stats: NULL share per parsed field (monitoring.FieldStats), stored for comparison with later runs.
    misses_to_confirm: complete runs in a row that must miss a listing before it counts as out of stock
    (1 = at once; 401 Games uses 2 because its search index drifts).
    Every variant marked out of stock gets a price_history row with source='missing'.
    """
    prev = conn.execute(
        "SELECT items_seen FROM scrape_runs WHERE store_id=%s AND status='ok' AND id<>%s ORDER BY id DESC LIMIT 1",
        (store_id, run_id)).fetchone()
    status, notes = "ok", None
    if error:
        status, notes = "failed", error
    elif items_seen == 0:
        status, notes = "failed", "no items returned"
    elif prev and items_seen < MIN_RATIO * prev[0]:
        status, notes = "suspect", f"{items_seen} items vs {prev[0]} last good run"
    listings_out = variants_out = 0
    if status == "ok":
        # a listing this run didn't see has one more miss; it's out of stock once it reaches misses_to_confirm
        conn.execute("""UPDATE listings SET missed_runs = missed_runs + 1
                        WHERE store_id=%s AND last_run_id IS DISTINCT FROM %s AND in_stock""", (store_id, run_id))
        listings_out = conn.execute(
            """UPDATE listings SET in_stock=false
               WHERE store_id=%s AND last_run_id IS DISTINCT FROM %s AND in_stock AND missed_runs >= %s""",
            (store_id, run_id, misses_to_confirm)).rowcount
        # variants removed from a listing that was seen (certain), and every variant of a listing that's now out;
        # not the variants of a listing that was only missed once and isn't confirmed yet
        variants_out = conn.execute(
            """WITH gone AS (
                   UPDATE variants SET in_stock=false FROM listings l
                   WHERE variants.listing_id=l.id AND l.store_id=%s AND variants.last_run_id IS DISTINCT FROM %s
                     AND variants.in_stock AND (l.last_run_id = %s OR NOT l.in_stock)
                   RETURNING variants.id, variants.price, variants.quantity)
               INSERT INTO price_history (variant_id, price, quantity, in_stock, source)
               SELECT id, price, quantity, false, 'missing' FROM gone ON CONFLICT DO NOTHING""",
            (store_id, run_id, run_id)).rowcount
    conn.execute("""UPDATE scrape_runs SET finished_at=now(), status=%s, items_seen=%s, items_with_problems=%s,
                        notes=%s, listings_marked_out=%s, variants_marked_out=%s, field_stats=%s WHERE id=%s""",
                 (status, items_seen, items_with_problems, notes, listings_out, variants_out,
                  Jsonb(field_stats) if field_stats is not None else None, run_id))
    return status, notes
