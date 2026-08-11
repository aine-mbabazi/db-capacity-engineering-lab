# 🧾 On-Call Lab Journal — Regional Health

**Engineer:** ______________________  **Date:** ______________________

This is your investigation notebook. You are on call for the Regional Health
platform and working the [incident queue](./incidents/README.md). For each
incident you will:

1. **Hypothesis** — from the ticket symptoms alone, predict the cause *before*
   you run anything.
2. **Observation** — record real evidence: k6 output, Grafana/Prometheus
   metrics, `EXPLAIN ANALYZE` plans, lock views, `docker stats`, container logs.
3. **Root cause & mechanism** — explain *why* it happens. Name the database/OS
   mechanic yourself and show the capacity math.
4. **Fix & verify** — make the change, re-run the reproduction, and record the
   before/after.

> There is no answer key. A claim without evidence isn't a diagnosis. "It felt
> slow" is not an observation; `p(95)=1840ms, http_req_failed=32%` is.

---

## How to capture evidence

- **k6:** copy the summary block (`http_req_duration`, `http_req_failed`,
  `iterations`, `vus`).
- **MySQL:** `docker compose exec mysql-db mysql -uroot -plabpassword capacity_lab`
  then run `EXPLAIN ANALYZE ...`, `SHOW CREATE TABLE ...`,
  `SHOW ENGINE INNODB STATUS\G`, or query `performance_schema` / `sys`.
- **Metrics:** Grafana panels or raw Prometheus at http://localhost:9090.
- **Memory / restarts:** `docker stats`, `docker compose logs -f capacity-api`.

Useful Prometheus queries:
```promql
# Throughput (req/s) by route
sum(rate(http_requests_total[1m])) by (route)

# p95 latency by route
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[1m])) by (le, route))

# Application heap in use
nodejs_heap_size_used_bytes

# DB errors by code
sum(rate(db_errors_total[1m])) by (code)
```

---

## Baseline — steady state (do this first)
*Run:* `k6 run load-tests/00-baseline.js` (healthy system, no incident)

Capture the control group you'll compare every incident against.

| Metric              | Value |
|---------------------|-------|
| Requests/sec (RPS)  |       |
| p50 latency         |       |
| p95 latency         |       |
| p99 latency         |       |
| Error rate          |       |
| Peak API heap used  |       |

> SLOs you'll hold the incidents to (target p95, max error rate, RPS floor):
> ____________________________________________________________________________

---

## Investigation — OPS-2201
*Ticket:* [Patient name search unusably slow at shift change](./incidents/OPS-2201.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2201.js`

### Hypothesis
> From the symptoms alone (fast when isolated, collapses under concurrent
> searches, other endpoints unaffected), I think the cause is a full table
> scan on the `last_name` column, likely with no supporting index, combined
> with an unbounded result set (no LIMIT). This would explain why a single
> search feels instant (one scan is cheap) but concurrent searches compete
> for CPU/disk I/O and blow up non-linearly, while other endpoints (like
> "recent patients", likely ordered by an indexed column) are unaffected
> because they don't share this access pattern.

### Observation (evidence)
> Confirmed via EXPLAIN ANALYZE that the search executes a full table scan:
> ```
> mysql> EXPLAIN ANALYZE SELECT * FROM patients WHERE last_name = 'Smith';
> -> Filter: (patients.last_name = 'Smith')  (cost=10276 rows=9819)
>    (actual time=0.0527..91.8 rows=10000 loops=1)
>    -> Table scan on patients  (cost=10276 rows=98191)
>       (actual time=0.0356..81.4 rows=100000 loops=1)
> ```
> No index existed on `last_name` (confirmed via SHOW CREATE TABLE — only
> PRIMARY KEY(id) existed). The endpoint also ran `SELECT *` with no LIMIT,
> returning every matching row (~10,000 for a common surname) with every
> column, including a TEXT `notes` field.

| Metric (under load) | Value | vs. baseline |
|---------------------|-------|--------------|
| p95 latency         | 33.77s | ~1,330x worse (baseline 25.37ms) |
| RPS                 | 9.23  | ~5.4x worse (baseline 49.49) |
| Error rate          | 0.00% | same (requests succeed, just extremely slow) |
| Rows examined / req | ~100,000 (full scan) | N/A (no baseline scan) |

### Root cause & mechanism
> MySQL performs a full table scan for every search request because no index
> exists on `last_name` — it must read all ~100,000 rows to find matches
> regardless of how many actually match. This costs ~80-90ms of real work per
> request even in isolation, which is why a lone search "feels instant."
> Under shift-change concurrency (200 simultaneous searchers), 200 concurrent
> full-table scans compete for the same CPU and buffer-pool I/O, and — because
> the query also has no LIMIT — 200 concurrent multi-thousand-row, full-column
> JSON payloads (including large TEXT notes fields) compete for serialization
> time on Node's single-threaded event loop. This matches classic queueing
> behavior: service time stays roughly fixed per request, but queue time
> explodes non-linearly once concurrent demand crosses the system's effective
> capacity — the "hockey stick."
>
> Capacity math: without an index, cost scales O(n) with table size — every
> search reads all ~100,000 rows no matter how many match. With a B-tree
> index, cost scales closer to O(log n + k) where k is the number of actual
> matches — for ~100,000 rows that's roughly 17 comparisons to locate the
> start of a match range, versus 100,000 row reads. This is a fundamentally
> different amplification profile, not just "the same query, done faster."

### Fix & verify
> The change you made (be specific): Two changes — (1) added a B-tree index
> on `last_name` via `ALTER TABLE patients ADD INDEX idx_last_name (last_name)`,
> persisted in `data-seed/seed.sh` so it survives a re-seed; (2) changed the
> query from `SELECT * FROM patients WHERE last_name = ?` (unbounded) to
> `SELECT id, first_name, last_name, diagnosis FROM patients WHERE last_name = ? LIMIT 50`
> (bounded, fewer columns, no large TEXT field).
>
> Before applying the LIMIT fix, I isolated the index's effect alone and also
> tested increasing `connectionLimit` from 2 to 20 as an alternative fix.
> That made p95 WORSE (48.4s vs the 33.77s pre-fix baseline) — direct
> counter-evidence that connection pool size was not the bottleneck. More
> connections meant more concurrent giant payloads competing for the same
> single-threaded CPU doing JSON serialization, which made contention worse.
> I reverted the pool to its original size (2) and applied the LIMIT fix
> instead, which was the actual root cause.
>
> Re-run evidence — new query behaviour: `EXPLAIN ANALYZE` now shows
> `Index lookup on patients using idx_last_name` instead of a table scan,
> cost dropped from 10276 to 2371.
>
> New p95: 248.71ms  New RPS: 1131.86  Improvement factor: ~136x (p95), ~123x (RPS)
>
> Any trade-off introduced by your fix? At this much higher throughput
> ceiling, a new failure mode surfaced: ~24.68% of requests failed with
> connection resets/EOF errors. This appears to be `connectionLimit: 2` in
> `api/database.js` becoming a bottleneck now that requests complete fast
> enough for far more of them to queue for the same 2 connections within a
> given window. This is a different mechanism from OPS-2201's reported
> symptom (which is now fully resolved) and looks like it may be the
> underlying mechanism behind OPS-2202 — investigating there rather than
> patching here.

## Investigation — OPS-2202
*Ticket:* [Whole app freezes during surges, DB looks idle](./incidents/OPS-2202.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2202.js`

### Hypothesis
> Given the query is trivial and the DB is idle yet requests pile up, I think
> the bottleneck is the application's connection pool (connectionLimit: 2 in
> api/database.js) combined with unbounded queueing (queueLimit: 0). Every
> request, no matter how cheap, must wait for one of only 2 MySQL connections
> before it can even run -- under a surge, requests would pile into an
> ever-growing queue rather than being rejected, explaining why the DB stays
> idle (it's only ever serving 2 queries at once) while the app appears frozen.

### Observation (evidence)
> Confirmed via docker stats during the surge:
> ```
> capacity-api   CPU 156.08%   MEM 84.11MiB/160MiB (52.57%)
> mysql-db       CPU 22.90%    MEM 200.8MiB/15.43GiB (1.27%)
> ```
> MySQL is nowhere near saturated (22.9% CPU) while capacity-api is CPU-bound
> at over 1 core (156%) -- the bottleneck is in the app tier, not the DB engine.
> No 500 errors occurred; requests simply queued for multiple seconds before
> eventually succeeding.

| Metric                    | Value | vs. baseline |
|---------------------------|-------|--------------|
| Successful RPS (plateau)  | 574 (arrival rate) | ~11.6x baseline |
| p95 / p99 latency         | p95=4.57s | ~180x worse than baseline (25.37ms) |
| Error / timeout rate      | 0.00% (queueing, not failing) | same |
| Avg service time per query (s) | 0.0105s (10.5ms, measured via curl) | -- |

### Root cause & mechanism
> Explain the paradox: idle database, trivial query, stalled app. What finite
> resource is being contended, and where does it live? Derive the *right* size
> for that resource from your measured throughput and service time (state the
> relationship you used):
> - Measured avg service time W = 0.0105 s
> - Target throughput lambda = 574 req/s (measured surge arrival rate)
> - Required capacity = lambda x W = 574 x 0.0105 approx 6 connections needed
>   to keep pace; with headroom (the deck's "50% rule"), ~12 would be a
>   reasonable minimum. The pool only had 2 -- roughly 3x under-provisioned
>   relative to actual demand, though as shown below, simply raising this
>   number doesn't solve the problem.
>
> The contended resource is the MySQL connection pool acting as an admission
> gate: with only 2 connections and queueLimit: 0 (unlimited queueing), every
> request beyond the pool's ~190 req/s serving capacity (2 connections /
> 0.0105s) piles into an unbounded internal queue rather than being rejected.
> Per Little's Law (L = lambda x W), as queue depth L grows without bound,
> wait time explodes non-linearly -- the classic queueing "hockey stick."
>
> Why does making it arbitrarily large eventually stop helping? Because the
> real constraint isn't connection count -- it's the application's single CPU
> core / single-threaded event loop. More connections just means more work
> (query execution, JSON serialization) competing for the same CPU at once,
> which increases contention rather than relieving it -- confirmed directly below.

### Fix & verify
> The change you made: Added admission-control middleware that caps concurrent
> in-flight requests at 100, returning a fast, explicit 503 Service Unavailable
> for anything beyond that cap, instead of letting requests queue indefinitely.
> Before landing on this, I tested the intuitive "just add more connections" fix
> (connectionLimit 2 to 20) as a control: it made things WORSE (p95 rose from
> 4.57s to 14.04s, error rate rose from 0% to 19%), which is direct
> counter-evidence that pool size was never the bottleneck. Reverted the pool
> to 2 and applied the admission-control fix instead.
>
> New RPS: unchanged arrival rate (574 req/s), but requests are now resolved
> quickly either way -- overall p95 latency ~100ms (200s and 503s combined)
> at a 150-VU test.
> New error rate: at 150 VUs, 94.96% of requests get 503 (correct behavior --
> intentionally overloading a 100-concurrent-request cap with continuous
> 150-VU load); overall response time for both 200s and 503s stayed under
> 1.2s even in the worst case, vs. multi-second-to-collapse before.
> New p95 (successful requests only): 1.17s.
>
> What upstream protection would make a burst degrade gracefully instead of
> collapsing? The admission-control middleware itself is that protection --
> callers get a fast, actionable 503 instead of an indefinite hang, so clients
> can retry with backoff instead of piling on. A production deployment would
> pair this with a reverse proxy / load balancer doing the same admission
> control at the network edge, since at extreme concurrency (2000+ VUs in
> testing) the OS TCP listen backlog gets exhausted before requests even reach
> this middleware -- a limitation discovered during testing, documented in
> evidence/OPS-2202-evidence.md.

## Investigation — OPS-2203
*Ticket:* [Bed admissions fail with DB errors under load](./incidents/OPS-2203.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2203.js`

### Hypothesis
> Given one-at-a-time works but concurrent admits to the *same* hospital fail,
> I think the cause is _____________________________________________________
> and the failure will show up as ______ (a DB error? a timeout? a stall?) ___.

### Observation (evidence)
> While the reproduction runs, inspect concurrent writers to one row:
> ```sql
> SELECT * FROM performance_schema.data_locks\G
> SELECT * FROM sys.innodb_lock_waits\G
> SHOW ENGINE INNODB STATUS\G   -- TRANSACTIONS section
> ```
> Paste the most telling waiter/blocker rows and the failure signature you saw
> (a DB error + code, a timeout, or stalled/near-zero throughput):
> ```
>
> ```
| Metric                     | Value | vs. baseline |
|----------------------------|-------|--------------|
| p95 / p99 latency          |       |              |
| Max successful admits/sec  |       |              |
| DB error(s) + code         |       |              |
| Error rate                 |       |              |

### Root cause & mechanism
> Explain why concurrency cannot beat serialization on a single hot row. If the
> critical section is held for W seconds per admit, what is the theoretical max
> throughput for that one row, regardless of how many callers pile on?
> 1 / W = ______ admits/sec. Where does the time in the critical section go, and
> which of the transactional guarantees is enforcing the wait? ________________

### Fix & verify
> The change you made (consider: shrinking the critical section, moving slow
> work out of the transaction, atomic guarded updates, reducing contention on
> the hot row): _____________________________________________________________
> Re-measured throughput / error rate: ______________________________________

---

## Investigation — OPS-2204
*Ticket:* [Nightly export crashes the service repeatedly](./incidents/OPS-2204.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2204.js`

### Hypothesis
> Given memory spikes right before each restart and only the big export is
> affected, I think the cause is ___________________________________________
> because __________________________________________________________________.

### Observation (evidence)
> Watch `nodejs_heap_size_used_bytes`, GC pauses, and restarts:
> ```bash
> docker stats
> docker compose logs -f capacity-api
> ```
| Metric                          | Value |
|---------------------------------|-------|
| Approx. payload size per request|       |
| Peak heap before crash          |       |
| Time-to-first-crash             |       |
| Container restart count         |       |
| GC pause trend                  |       |

> Paste the crash / exit log lines:
> ```
>
> ```

### Root cause & mechanism
> Estimate per-row size, then the full payload: rows × bytes/row = ______ MB.
> With C concurrent callers, peak resident memory ≈ ______ MB — compare to the
> container's memory budget (160MB locally / 256MB in prod). Explain what happens
> to GC frequency, CPU, and
> throughput as live heap approaches the limit, and why the current approach
> uses O(N) memory while a better one could use far less. ____________________

### Fix & verify
> The change you made (consider: bounding how much of the result set is in
> memory at once, streaming to the response, sensible page sizes, compression):
> ____________________________________________________________________________
> Re-run evidence — new peak heap: ______  restarts: ______  error rate: ______

---

## Post-incident review (synthesis)

> Rank the four incidents by **blast radius** (threat to overall availability at
> scale), justified with your measured numbers:
> 1. ____________________________________________________________________
> 2. ____________________________________________________________________
> 3. ____________________________________________________________________
> 4. ____________________________________________________________________
>
> If you could ship only **one** fix before a launch, which and why?
> ____________________________________________________________________________
>
> For each incident, what alert or dashboard would have caught it in production
> *before* a user filed a ticket? ____________________________________________
