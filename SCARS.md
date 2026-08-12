# 🩹 Scar Log — Regional Health

One entry per incident: the permanent, one-screen record of a wound and the
lesson it left. See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the template.

---

## OPS-2201 — Patient search full table scan + unbounded result set

- **S — Symptom:** Night charge nurse reported patient name search "unusably
  slow" at shift change; symptom implied concurrent searches under load.
- **C — Cause:** `/api/patients/search` ran `SELECT * FROM patients WHERE
  last_name = ?` with no index on `last_name` and no `LIMIT` — every request
  forced a full table scan (~100,000 rows, `EXPLAIN ANALYZE` cost=10276) and
  returned an unbounded, full-column result set (up to ~10,000 rows for a
  common surname, including a large TEXT `notes` field). A single search felt
  fast in isolation (~80-90ms scan work); at shift-change concurrency (200
  simultaneous searchers), 200 concurrent full scans competed for CPU/
  buffer-pool I/O and 200 concurrent multi-megabyte JSON serializations
  competed for Node's single-threaded event loop.
- **Action:** Added a B-tree index on `last_name` (persisted in
  `data-seed/seed.sh`); changed the query to `SELECT id, first_name,
  last_name, diagnosis FROM patients WHERE last_name = ? LIMIT 50`. Tested
  raising `connectionLimit` from 2 to 20 first as a control — it made p95
  WORSE (48.4s vs 33.77s), ruling out pool size before applying the real fix.
- **Result:** `EXPLAIN ANALYZE` cost dropped 10276 → 2371 (table scan → index
  lookup). p95 33.77s → 248.71ms (~136x), RPS 9.23 → 1131.86 (~123x).
  Trade-off: at this much higher throughput, a new failure mode surfaced —
  24.68% connection resets/EOF, caused by `connectionLimit: 2` becoming the
  binding constraint once requests completed fast enough to queue heavily.
  Not fixed here; flagged as the likely mechanism behind OPS-2202.
- **Scar / lesson:** "Add more connections" is not a safe default fix —
  tested directly and made things worse, because more concurrent giant
  payloads meant more contention for the same single-threaded CPU doing JSON
  serialization. The real lever was reducing rows/columns read per request
  (index + LIMIT), i.e. less time-in-system, not more raw capacity on the
  wrong resource. A dashboard alerting on p95 latency by route, or on
  full-table-scan queries, would have caught this before a shift-change
  ticket was filed.
- **Evidence:** [`LAB_JOURNAL.md` — Investigation OPS-2201](./LAB_JOURNAL.md);
  `evidence/OPS-2201-evidence.md` (EXPLAIN ANALYZE before/after, k6 summaries).

## OPS-2202 — Registration surge collapses the app while MySQL sits idle

- **S — Symptom:** On-call SRE reported the whole app "freezes" during
  traffic surges while the database looks idle — a paradox: trivial query,
  DB not saturated, app appears stuck.
- **C — Cause:** No admission control and an unbounded connection-acquisition
  queue (`queueLimit: 0`) sitting on only 2 MySQL connections
  (`connectionLimit: 2`). Every request, however cheap, had to wait for one
  of 2 connections before starting. Measured service time W = 0.0105s; by
  Little's Law the pool could sustain ~190 req/s, but the surge generated
  ~574 req/s (~3x capacity). With no queue cap, excess requests piled up
  indefinitely, and wait time grew non-linearly with queue depth — `docker
  stats` confirmed MySQL at 22.9% CPU (idle) while capacity-api was CPU-bound
  at 156% (over 1 core): the bottleneck was the app-tier queue, not the DB.
- **Action:** Added admission-control middleware capping concurrent in-flight
  requests at 100, returning a fast, explicit 503 beyond the cap instead of
  unbounded queueing. Tested raising `connectionLimit` 2→20 first as a
  control — WORSE again (p95 4.57s→14.04s, errors 0%→19.08%), confirming (a
  second time) pool size was not the real constraint. Bug found and fixed
  during testing: the first middleware version only decremented on
  `res.on('finish')`, which doesn't fire for aborted/reset connections —
  under a 2000-VU surge this leaked counter slots and got the service
  permanently stuck at 503 for everything, even at zero load; fixed by also
  listening on `res.on('close')` with a guard against double-decrementing.
- **Result:** At 150 VUs: overall p95 (200s+503s) ~100ms vs. 4.57s before;
  successful-request p95 1.17s (elevated under intentional overload, not
  collapsing); 94.96% get a fast, clean 503 rather than hanging. MySQL CPU
  stayed idle throughout, confirming the DB was never the bottleneck.
  Limitation: at extreme concurrency (2000+ VUs), TCP-level connection resets
  occur before requests even reach the middleware (OS listen-backlog
  exhaustion) — needs `server.maxConnections` tuning or a reverse proxy
  beyond that ceiling.
- **Scar / lesson:** "The database looks idle" does not mean the database is
  fine — check the app tier's own CPU/queueing first. Second incident in a
  row where "add more connections" was tested and proven wrong by direct
  measurement; this codebase's actual constraint is application-tier
  CPU/event-loop capacity, not connection count. Also: an admission-control
  fix needs its release path tested under aborted/reset connections
  specifically, or it can fail permanently-closed instead of
  gracefully-degraded. A dashboard on in-flight request count vs. the
  admission cap would have caught this before a P1 page.
- **Evidence:** [`LAB_JOURNAL.md` — Investigation OPS-2202](./LAB_JOURNAL.md);
  `evidence/OPS-2202-evidence.md` (docker stats, Little's Law math, k6
  summaries).

## OPS-2203 — Bed admissions serialize on a hot row lock held through an external call

- **S — Symptom:** ED operations lead reported bed admissions failing with DB
  errors under load — during a mass-casualty drill, concurrent admissions to
  the same hospital failed while different hospitals were largely unaffected.
- **C — Cause:** `/api/hospitals/:id/admit` held a row-level exclusive (X)
  lock on the target hospital's row (`SHOW ENGINE INNODB STATUS`: `RECORD
  LOCKS ... lock_mode X locks rec but not gap`) for the entire duration of a
  500ms `notifyBedRegistry()` call made *inside* the transaction, before
  `COMMIT` — not just for the near-instant `UPDATE`. Under InnoDB's
  two-phase locking protocol the lock isn't released until commit, so every
  concurrent admission to the same hospital queued behind it. Max serialized
  throughput for one row = 1/W = 1/0.5s = 2 admissions/sec, a hard ceiling
  regardless of concurrency; queued transactions exceeding
  `innodb_lock_wait_timeout` (50s) failed outright, matching the observed
  ~59.5s max latency and 99.84% error rate at 500 VUs.
- **Action:** Moved `notifyBedRegistry(hospitalId)` to *after*
  `conn.commit()`, fire-and-forget, so the exclusive lock releases as soon as
  the UPDATE commits instead of being held through the unrelated external
  call. Trade-off: the client no longer waits on/is informed of registry
  failures, since the admission is already safely committed by then —
  intentional, the notification is a side effect, not the correctness-critical
  write.
- **Result:** At 20 VUs (realistic same-hospital surge): p95 57.12s →
  221.62ms, error rate 99.84% → 0.00% (1590/1590 succeeded), ~2 admits/sec
  ceiling gone. Re-run at 500 VUs confirms the lock fix works — hold time
  ~500ms → ~ms, the 50-60s lock-wait timeouts are gone — but at that extreme
  concurrency a different, pre-existing bottleneck surfaces: connection
  resets/EOF, the same `connectionLimit: 2`/TCP-backlog signature already
  diagnosed in OPS-2202, not a new bug from this fix.
- **Scar / lesson:** Row-level locking itself was correct and necessary — the
  bug was scope: never hold a database lock across a network call to an
  external system. Any I/O that isn't part of the correctness-critical write
  belongs after commit, not inside the transaction. Third ticket in a row
  where the *same* `connectionLimit: 2` constraint reappears once another
  bottleneck is fixed — worth a cross-cutting fix, not a per-ticket patch. A
  dashboard on lock-wait-timeout error counts by table would have caught this
  before a mass-casualty drill did.
- **Evidence:** [`LAB_JOURNAL.md` — Investigation OPS-2203](./LAB_JOURNAL.md);
  `evidence/OPS-2203-evidence.md` (SHOW ENGINE INNODB STATUS, capacity math,
  k6 summaries).

## OPS-2204 — Nightly export OOM-kills the service under concurrent load

- **S — Symptom:** ETL/on-call reported the service "restarts over and over"
  during the nightly full-patient export, memory spiking right before each
  restart; other reads unaffected.
- **C — Cause:** `GET /api/patients/export` runs an unbounded `SELECT * FROM
  patients` (no LIMIT/pagination/streaming) and serializes the full ~100k-row
  result (~36.14MB/request, measured) in one shot. Under 50 concurrent
  callers, up to 50 of these payloads can be live in memory at once against a
  160MB container cap — demand exceeds capacity by ~10-11x. Whether the
  process survives at the ceiling is a race between allocation rate and
  GC/kernel reclaim, not deterministic: an identical re-run produced 0
  restarts once and 2 SIGKILL/OOM restarts (23s apart) the next time.
- **Action:** Rewrote `/api/patients/export` to stream bounded 1,000-row
  chunks via keyset pagination (`WHERE id > ? ORDER BY id LIMIT ?`) instead of
  materializing all ~100k rows and `res.json()`-ing them at once; fixed the
  `NODE_OPTIONS`/cgroup mismatch in `docker-compose.yml`, capping
  `--max-old-space-size` at 112MB (down from 256MB, below the 160MB container
  limit instead of above it).
- **Result:** Errors 0.00% (100/100 succeeded) vs. 57.14%/99.92% pre-fix;
  restarts 0 vs. 0/2; peak RSS 128.7MiB (80.3%, never pinned) vs. pinned at
  159.5-160MiB (~100%) in both pre-fix runs. OOM/restart problem eliminated.
  Trade-off: `connectionLimit: 2` is now the binding constraint — each export
  needs ~101 sequential DB round trips, so avg/p95 request duration is now
  ~74s. Still a strict availability improvement (bounded latency, zero errors
  vs. a coin-flip between surviving-pinned and OOM-kill-with-mass-failure),
  but 74s/export is not itself a good number — raising/tuning
  `connectionLimit` is flagged as follow-up scope, not fixed here. Based on a
  single post-fix verification run (a second run was planned but not executed
  due to time constraints) — noted as a limitation, not hidden, especially
  since the pre-fix behavior was itself non-deterministic run-to-run.
- **Scar / lesson:** A dashboard alerting on `nodejs_heap_size_used_bytes`
  against the 256MB `--max-old-space-size` figure would miss this entirely —
  heap only reached ~118-158MB, nowhere near that ceiling, while the
  container was already dying against its real (tighter, different) 160MB
  cgroup limit. Alert on **container RSS as a fraction of the cgroup memory
  limit**, not the Node-reported heap figure. Also: this failure mode is
  non-deterministic right at the ceiling — one clean run without a restart
  does not prove the condition is safe; reproduce more than once before
  ruling a cause out.
- **Evidence:** [`LAB_JOURNAL.md` — Investigation OPS-2204](./LAB_JOURNAL.md);
  `docker events` (oom @ 08:01:45.116 & 08:02:08.412, both exitCode=137); k6
  run summaries in the journal above.
