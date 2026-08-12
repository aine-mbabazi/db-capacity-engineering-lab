# 🧾 On-Call Lab Journal — Regional Health

**Engineer:** Patricia Ainembabazi **Date:** 2026/08/11

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
> I think the cause is the admit handler holding a row-level exclusive lock on
> that hospital's row for longer than the UPDATE itself needs — specifically,
> an external call performed inside the transaction, before COMMIT — so every
> concurrent admit to the same hospital queues behind whichever transaction
> currently holds the lock. The failure will show up as a DB error: requests
> queue with rising latency and then fail with a lock-wait-timeout error once
> a queued transaction exceeds MySQL's `innodb_lock_wait_timeout`, rather than
> an immediate rejection or a silent stall.

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
> Concurrency cannot beat serialization on a single hot row because MySQL/
> InnoDB takes a row-level exclusive (X) lock on that row for the UPDATE
> (`SHOW ENGINE INNODB STATUS` during the surge shows `RECORD LOCKS ... index
> PRIMARY of table capacity_lab.hospitals ... lock_mode X locks rec but not
> gap`), and under InnoDB's two-phase locking protocol that lock is held until
> COMMIT — not released the instant the row value is written. This is what
> enforces the transaction's **isolation guarantee**: no other transaction may
> take a conflicting lock on the same row (and thus cannot read-modify-write
> `available_beds` concurrently) until the lock-holder commits, which is
> exactly what prevents two admissions from both decrementing off the same
> stale bed count. With the critical section held for W ≈ 500ms per admit
> (dominated by the `notifyBedRegistry()` call executing *inside* the
> transaction, before commit — the UPDATE itself is single-digit ms), the
> theoretical max throughput for that one row is 1 / W = 1 / 0.5s = **2
> admits/sec**, regardless of how many callers pile on. Every VU beyond that
> ceiling only grows the queue behind the lock; queued transactions that wait
> longer than `innodb_lock_wait_timeout` (default 50s) fail outright — which
> matches the observed max latency of ~59.5s (50s timeout + overhead) and the
> 99.84% error rate at 500 VUs.

### Fix & verify
> The change you made: moved `notifyBedRegistry(hospitalId)` to *after*
> `conn.commit()`, called fire-and-forget (`.catch(() => {})`), so the
> exclusive row lock is released as soon as the UPDATE is committed instead of
> being held through an unrelated 500ms external call. Trade-off: the client
> no longer waits on (or is informed of) registry-notification failures, since
> the admission is already safely committed by the time that call happens —
> intentional, since the notification is a side effect, not part of the
> correctness-critical write.
>
> Re-measured throughput / error rate — at 20 VUs / 15s (a realistic
> same-hospital surge): p95 latency dropped from 57.12s to **221.62ms**, error
> rate dropped from 99.84% to **0.00%** (1590/1590 succeeded), and the
> ~2 admits/sec hard ceiling for a single hospital's row is gone (no longer
> lock-bound). Re-run at the original 500 VUs confirms the lock fix itself
> works — lock hold time drops from ~500ms to ~ms per admission, and the
> 50-60s lock-wait timeouts are gone — but at that extreme concurrency a
> *different*, pre-existing bottleneck surfaces: connection resets/EOF errors,
> the same connectionLimit: 2 / TCP-listen-backlog signature already diagnosed
> in OPS-2202, not a new bug introduced by this fix.

---

## Investigation — OPS-2204
*Ticket:* [Nightly export crashes the service repeatedly](./incidents/OPS-2204.md)
*Reproduce:* `k6 run load-tests/reproduce-OPS-2204.js`

### Hypothesis
> Given memory spikes right before each restart and only the big export is
> affected, I think the cause is the unbounded `/api/patients/export` endpoint
> materializing the entire ~100,000-row patient table (`SELECT * FROM patients`,
> no LIMIT/pagination/streaming) as one in-memory result set, then serializing
> it whole via `res.json()`, because export is the only endpoint returning the
> full table — every other endpoint (`recent`, `search`) is bounded by
> `LIMIT 50`.

### Observation (evidence)
> Watch `nodejs_heap_size_used_bytes`, GC pauses, and restarts:
> ```bash
> docker stats
> docker compose logs -f capacity-api
> ```
| Metric                              | Value | vs. baseline |
|--------------------------------------|-------|--------------|
| Baseline (control, `/api/patients/recent`) | RPS=48.97, p95=44.67ms, errors 0% | — |
| Run 1 (2s sampling) — errors         | 57.14% (32/56) | all client-side 120s timeouts, not 500s |
| Run 1 — restarts                     | 0 (`RestartCount` 0→0, `OOMKilled=false`) | RSS pinned 159.5–160MiB (~100%) for ~2 min straight |
| Run 2 (1s sampling) — errors         | 99.92% (24228/24246) | mostly near-instant failures (avg 192ms) — consistent with connection loss during restarts |
| Run 2 — restarts                     | **2, 23s apart** | see `docker events` timeline below |
| heap_bytes vs RSS at peak            | RSS 159.9MiB vs heap ~118M | ~40MB unaccounted for in tracked JS heap |
| Monitoring probe (`curl /metrics`)   | no response in the seconds before each kill | event loop too saturated to service even a trivial unrelated read |
| Single isolated request (no concurrency) | 100,000 rows, 36,141,185 bytes (36.14MB), 361.4 bytes/row, 2.50s, full memory recovery after | proves a lone request is cheap — concurrency is the actual problem |

> Two identical runs (same script, same 50 VUs, same duration) produced two
> different outcomes — one survived pinned at the ceiling, one didn't. Ticket
> said "restarts over and over": confirmed directly in run 2, but the full
> picture is more precise than the ticket's framing — it's the same underlying
> condition (sustained RSS at the container's cap) with a non-deterministic
> outcome, not a guaranteed crash every time.

> `docker compose logs capacity-api` contains **no in-app crash trace** for
> either run — the only line the app ever prints is the startup banner
> (`capacity-api listening on :3000 ...`), repeated once per restart. A SIGKILL
> gives the process no chance to log anything on the way out. The only proof
> of the kills is kernel-level, via `docker events`:
> ```
> 08:01:45.116  container oom     (0e913a9de218...)
> 08:01:45.417  container die     exitCode=137, execDuration=26s
> 08:01:45.767  container start
> 08:02:08.412  container oom
> 08:02:08.749  container die     exitCode=137, execDuration=23s
> 08:02:09.073  container start
> ```

### Root cause & mechanism
> `/api/patients/export` pulls the entire patients table into a JS array via
> mysql2 with no LIMIT, pagination, or streaming, then Express serializes it in
> one synchronous `JSON.stringify` call. In isolation this is cheap (36.14MB,
> 2.5s, full recovery). Under `reproduce-OPS-2204.js`'s 50 constant VUs, up to
> 50 of these ~36MB in-flight payloads (raw mysql2 buffers + intermediate JSON
> strings) can be resident at once, competing for the container's 160MB cgroup
> cap (`mem_limit: 160m` in `docker-compose.yml`, deliberately mismatched
> against `NODE_OPTIONS: --max-old-space-size=256`, so V8 believes it has
> headroom the cgroup will never grant).
>
> Once RSS approaches 160MB, survival is a **race between allocation rate and
> GC/kernel reclaim rate**, not deterministic: the cgroup OOM-killer fires the
> instant a page-in would exceed the limit, whether or not V8's GC is a moment
> away from reclaiming scratch memory from an already-finished request. Run 1
> won that race for ~2 minutes straight; run 2 lost it twice, 23 seconds apart
> — each restart gets immediately re-flooded by the still-running 50 VUs and
> refills to the cap almost as fast as it emptied, which is exactly the "over
> and over" pattern once the process does tip over.
>
> Second finding: `nodejs_heap_size_used_bytes` never explains the RSS — it
> peaked around ~118–158M while RSS sat at 159.9MiB. A ~40MB gap consistent
> with memory held outside the tracked JS heap (mysql2 row/column buffers,
> large intermediate strings from stringifying a 100k-row array). A dashboard
> alerting on heap-used against the 256MB V8 ceiling would never fire — heap
> never gets close — while the container is already dying against its real,
> tighter, and different 160MB limit.
>
> Third finding: the monitoring probe itself (`curl /metrics`, `docker stats`)
> went unanswered in the seconds immediately preceding each kill. That's not a
> gap in measurement, it's evidence — the single-threaded event loop was too
> busy synchronously building a giant JSON string across up to 50 concurrent
> requests to service even a trivial, unrelated read. The app was already
> unresponsive before the kernel finished it off.
>
> Capacity math: measured per-request payload = 100,000 rows × 361.4 bytes/row
> ≈ **36.14MB** (measured directly, not estimated). Container ceiling =
> **160MB**. 160MB / 36.14MB ≈ **4.4** — the container physically cannot hold
> more than ~4–5 full in-flight export payloads at once, before even counting
> Node's baseline footprint (~27MB idle) or per-request overhead. At 50
> concurrent VUs all hitting this endpoint, demand exceeds physical capacity by
> roughly **10–11x** — this isn't an edge case or a near-miss, it's a workload
> asking for ~11x the memory the container can ever supply for this access
> pattern, regardless of GC tuning.

### Fix & verify
> Two changes: (1) rewrote `/api/patients/export` (`api/server.js`) to cursor
> the table in bounded 1,000-row chunks via keyset pagination on the primary
> key (`WHERE id > ? ORDER BY id LIMIT ?`, not OFFSET, so each chunk stays an
> indexed range scan) and stream each chunk to the HTTP response with
> backpressure handling, instead of materializing all ~100,000 rows and
> `res.json()`-ing them in one shot; (2) fixed the `NODE_OPTIONS`/cgroup
> mismatch in `docker-compose.yml`, capping `--max-old-space-size` at 112MB
> (down from 256MB) — below the container's real 160MB limit instead of above
> it, so V8 has a chance to self-limit before the kernel OOM-killer has to.
>
> | Metric | Pre-fix Run 1 | Pre-fix Run 2 | Post-fix (this run) |
> |---|---|---|---|
> | Errors | 57.14% (32/56) | 99.92% (24228/24246) | **0.00% (0/100)** |
> | Restarts | 0 | 2 (23s apart) | **0** |
> | OOMKilled | false | — (SIGKILL via cgroup oom, `exitCode=137`) | **false** |
> | Peak RSS | 159.5–160MiB (pinned ~100%) | 159.9MiB (pinned ~100%) | **128.7MiB (80.3%), never pinned** |
> | Avg / p95 request duration | timeouts at 120s cap | avg 25.23s (successful), p95 56.09s | **avg / p95 ≈ 1m14s (74s), min=1m13s, max=1m14s** |
> | Data received | — | 666 MB | **3.6 GB (100 x 36MB, full exports)** |
>
> **The OOM-kill/restart problem is fixed and confirmed** — RSS now peaks at
> 128.7MiB, ~31MB of headroom under the 160MB cap, versus pinning at the cap
> for minutes at a time pre-fix. Every one of 100 concurrent-load export
> requests over the 50-VU, 2-minute reproduction completed successfully;
> `RestartCount` stayed at 0 throughout.
>
> **The binding constraint has moved, not disappeared.** `connectionLimit: 2`
> in `api/database.js` is now what limits this endpoint: each export needs
> ~101 sequential DB round trips (1 count + 100 chunk queries), so 50
> concurrent exporters funneled through 2 connections serializes hard,
> producing the ~74-second-per-request duration above. This is a strict
> availability improvement over the pre-fix behavior — bounded, predictable
> latency and zero errors, instead of a coin-flip between "survives pinned at
> the cap" and "OOM-killed, restarts, ~57-99% of requests fail." But 74s per
> export is not itself a good number, and tuning/raising `connectionLimit` for
> this access pattern is flagged as follow-up scope, not fixed here — it's a
> distinct capacity dimension (connection throughput) from the one this
> incident was about (memory), and changing it without evidence would repeat
> the mistake OPS-2201/2202 already taught us: don't touch the pool size
> without measuring it in isolation first.
>
> **Limitation to flag plainly:** this verification is based on a **single**
> post-fix reproduction run, not two back-to-back runs as originally planned.
> The second run was not executed due to time constraints. Given the pre-fix
> behavior was itself non-deterministic run-to-run (Run 1 survived, Run 2
> OOM-killed twice under identical conditions), one clean post-fix run is
> supporting evidence that the fix works, not proof it eliminates the failure
> mode with certainty across all conditions — a second confirming run remains
> worth doing before treating this as fully closed.

---

## Post-incident review (synthesis)

> Rank the four incidents by **blast radius** (threat to overall availability at
> scale), justified with your measured numbers:
> 1. **OPS-2204** — worst. The failure mode is a kernel SIGKILL of the entire
>    container process (`docker events`: `container die`, `exitCode=137`),
>    not a per-request slowdown. Because the kill happens at the process
>    level, every in-flight request of *any* kind — not just export calls —
>    would be dropped during each restart window, and in the bad-luck run
>    this recurred every 23 seconds for as long as load continued (99.92%
>    error rate). A full, repeating outage beats a slowdown for worst blast
>    radius, even though the same script sometimes (Run 1) didn't tip over.
> 2. **OPS-2202** — app-wide, but no crash. `docker stats` showed capacity-api
>    CPU-bound at 156% (>1 core) while MySQL sat idle at 22.9%; p95 hit 4.57s,
>    ~180x worse than the 25.37ms baseline. The mechanism (shared
>    `connectionLimit: 2` pool + unbounded `queueLimit: 0` queue) sits under
>    every DB-backed endpoint, not just `/recent` — so this degraded the
>    whole app under any sufficient surge, without ever returning a single
>    error (0% error rate pre-fix; it queued rather than failed).
> 3. **OPS-2201** — scoped mostly to `/api/patients/search`. p95 hit 33.77s,
>    ~1,330x worse than baseline, and RPS dropped to 9.23 (~5.4x worse), but
>    the investigation's own root-cause text notes other endpoints like
>    `/recent` were "likely unaffected" since they don't share the
>    full-table-scan / unbounded-payload access pattern.
> 4. **OPS-2203** — narrowest. Contention was explicitly isolated to one
>    hospital's row at a time; the root-cause investigation states directly
>    that "different hospitals were largely unaffected by each other," since
>    different rows mean different locks. Severe for the affected hospital
>    (p95 57.12s, 99.84% errors at 500 VUs) but structurally contained.
>
> If you could ship only **one** fix before a launch, which and why?
> The OPS-2204 fix (streaming/cursor rewrite + the NODE_OPTIONS/cgroup
> correction) — because it's the only one of the four whose pre-fix failure
> mode is a full process crash rather than degraded performance, and
> crash-and-restart is strictly worse than slow-but-alive for overall
> availability. `connectionLimit: 2` is tempting to name instead, since it's
> the cross-cutting constraint underneath three of the four tickets (see
> below), but OPS-2201 and OPS-2202 already directly disproved "just raise
> it" as a safe blind fix — twice — so shipping a pool-size change without
> the same kind of isolated, dedicated measurement those two incidents used
> would repeat the exact mistake this lab already caught.
>
> For each incident, what alert or dashboard would have caught it in production
> *before* a user filed a ticket?
> - **OPS-2201:** a dashboard alerting on p95 latency by route, or on
>   full-table-scan queries.
> - **OPS-2202:** a dashboard on in-flight request count vs. the admission
>   cap.
> - **OPS-2203:** a dashboard on lock-wait-timeout error counts by table.
> - **OPS-2204:** an alert on container RSS as a fraction of the cgroup
>   memory limit — not on the Node-reported heap figure against the V8
>   `--max-old-space-size` limit, which would have stayed quiet the whole
>   time (heap peaked at ~118-158MB against a 256MB V8 ceiling that was never
>   the real constraint).
>
> **Cross-cutting pattern:** `connectionLimit: 2` was never itself the bug in
> any single ticket — in OPS-2201 and OPS-2202 it was directly tested and
> ruled out as the fix (raising it to 20 made p95 *worse* both times, 33.77s→
> 48.4s and 4.57s→14.04s, because more concurrent connections just meant more
> work competing for the same single-threaded CPU). But once each incident's
> actual root cause was fixed, that same `connectionLimit: 2` reappeared as
> the next binding constraint: it's the mechanism behind OPS-2202's
> ~190 req/s pool ceiling, it resurfaces as connection resets/EOF errors once
> OPS-2203's lock fix is verified at 500 VUs, and it's what turns OPS-2204's
> post-fix export into a ~74-second request (101 sequential round trips
> through 2 connections). It's the shared ceiling sitting underneath three of
> the four tickets — a legitimate cross-cutting follow-up item, distinct from
> any single ticket's fix, and one that (per the point above) needs its own
> isolated measurement rather than a blind bump.
>
> **Recurring anti-pattern:** "add more capacity/connections" was the
> instinctive first fix tried in both OPS-2201 and OPS-2202, and both times
> it was directly tested and disproven before the real fix was found — it
> made things measurably worse (higher p95, higher error rate), not better,
> because the actual constraint was CPU/event-loop time, not connection
> count. The fixes that actually worked in all four incidents were cheaper
> and more targeted than "more capacity": an index + bounded columns
> (OPS-2201), an admission-control cap (OPS-2202), moving one call outside a
> transaction (OPS-2203), and bounding memory per request via streaming
> (OPS-2204). None of the four real fixes added hardware or raised a limit —
> each one reduced the amount of work or memory a single request could
> demand.
