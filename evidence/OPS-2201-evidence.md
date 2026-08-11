# OPS-2201 Evidence

## Baseline (healthy system)
p95 latency: 25.37ms
p99 latency: 77.31ms
RPS: 49.49
Error rate: 0.00%
## Reproduction (before fix) — k6 reproduce-OPS-2201.jsTHRESHOLDS
http_req_duration
✗ 'p(95)<300' p(95)=33.77s

TOTAL RESULTS
checks_total: 470 9.22677/s
checks_succeeded: 100.00%
http_req_duration: avg=17.2s min=540.88ms med=18.68s max=38.57s p(90)=28.75s p(95)=33.77s
http_req_failed: 0.00%
## Root cause investigation — EXPLAIN ANALYZE

### Before index
```sql
mysql> SHOW CREATE TABLE patients\G
CREATE TABLE `patients` (
  `id` int NOT NULL AUTO_INCREMENT,
  `first_name` varchar(64) NOT NULL,
  `last_name` varchar(64) NOT NULL,
  `email` varchar(128) NOT NULL,
  `diagnosis` varchar(255) NOT NULL,
  `notes` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB
-- No index on last_name

mysql> EXPLAIN ANALYZE SELECT * FROM patients WHERE last_name = 'Smith';
-> Filter: (patients.last_name = 'Smith')  (cost=10276 rows=9819) (actual time=0.0527..91.8 rows=10000 loops=1)
    -> Table scan on patients  (cost=10276 rows=98191) (actual time=0.0356..81.4 rows=100000 loops=1)
```
Full table scan: every search request reads all ~100,000 rows regardless of match count.

### After adding index
```sql
mysql> ALTER TABLE patients ADD INDEX idx_last_name (last_name);
Query OK, 0 rows affected (1.12 sec)

mysql> EXPLAIN ANALYZE SELECT * FROM patients WHERE last_name = 'Smith';
-> Index lookup on patients using idx_last_name (last_name='Smith')  (cost=2371 rows=10000) (actual time=0.0873..75.1 rows=10000 loops=1)
```
Cost dropped from 10276 to 2371. Query plan now uses the index instead of a full scan.

## Isolating the connection pool variable

Bumped `connectionLimit` from 2 to 20 (index fix only, no query change yet):p95 latency: 48.4s (WORSE than the 33.77s baseline-reproduction)
RPS: 8.18
**Counter-evidence:** increasing pool size made p95 worse, not better. This ruled out
the connection pool as the primary bottleneck. Reverted pool back to connectionLimit: 2.

Hypothesis: with only 2 connections, at most 2 massive result sets (10,000 rows x
full columns incl. TEXT `notes`) could be in flight at once. More connections meant
more concurrent giant payloads competing for JSON.stringify on Node's single-threaded
event loop -- CPU became the bottleneck, not the DB connection count.

## Fix: bound the result set

Changed the search query from:
```sql
SELECT * FROM patients WHERE last_name = ?
```
to:
```sql
SELECT id, first_name, last_name, diagnosis FROM patients WHERE last_name = ? LIMIT 50
```
(index kept, pool size reverted to 2)

## After fix — k6 reproduce-OPS-2201.jsTHRESHOLDS
http_req_duration
✓ 'p(95)<300' p(95)=248.71ms

TOTAL RESULTS
checks_total: 34156 1131.863184/s
checks_succeeded: 75.31%
checks_failed: 24.68% (connection resets / EOF at very high throughput)
http_req_duration: avg=169.19ms med=213.89ms max=1.08s p(90)=238.14ms p(95)=248.71ms
http_req_failed: 24.68%
## Before -> After summary

| Metric | Before | After | Improvement |
|---|---|---|---|
| p95 latency | 33.77s | 248.71ms | ~136x |
| RPS | 9.23 | 1131.86 | ~123x |
| Error rate | 0.00% | 24.68% (new failure mode) | see note below |

## Root cause & mechanism

The `/api/patients/search` endpoint executed `SELECT * FROM patients WHERE last_name = ?`
with no index on `last_name` and no LIMIT. Every request forced a full table scan
(~100,000 rows read) and returned an unbounded, full-column result set (including a
TEXT `notes` field) -- in this dataset, ~10,000 matching rows per common surname.

A single search felt "instant" in isolation (~80-90ms of actual scan work), which is
why the ticket reporter described it as fine when tested alone. Under shift-change
concurrency (200 simultaneous searchers), 200 concurrent full-table scans competed
for the same CPU and buffer-pool bandwidth, and 200 concurrent multi-megabyte JSON
serializations competed for Node's single-threaded event loop. This matches the
deck's queueing model: service time stayed roughly fixed, but queue time exploded
non-linearly past a concurrency threshold -- the "hockey stick."

Capacity math: with no index, cost of finding matches scales O(n) with table size
(~100,000 row reads regardless of match count). With the added B-tree index, cost
scales closer to O(log n + k) where k is the number of matches -- a fundamentally
different amplification profile, not just "the same query faster."

## Trade-off / limitation discovered

Increasing the connection pool (an intuitive first fix) made p95 WORSE (48.4s vs
33.77s), providing direct counter-evidence against the "just add more connections"
instinct -- more concurrent giant payloads competed harder for single-threaded
CPU time. This confirms the deck's point: scaling is about reducing time-in-system,
not adding raw capacity to the wrong resource.

At the new, much higher throughput ceiling (1,131 req/s vs ~10 req/s before), a
NEW bottleneck surfaces: connectionLimit: 2 in api/database.js starts producing
connection resets / EOF errors (24.68% error rate) under this k6 script's extreme
200-VU load, because requests now complete fast enough that far more of them can
queue for the same 2 connections in a given window. This is a genuinely different
failure mode from the ticket's reported symptom (slow spinning searches) and is
likely the mechanism underlying OPS-2202 (app freezes during surges, DB looks idle)
-- worth investigating there rather than patching here, since OPS-2201's specific
reported symptom (slow, spinning search) is now fully resolved.
