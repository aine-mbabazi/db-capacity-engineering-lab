# OPS-2204 Evidence

## Baseline (healthy system)
RPS: 48.97 (48.9681/s), p95 latency: 44.67ms, Error rate: 0.00%
k6 run load-tests/00-baseline.js, 50 VUs / 30s

## Reproduction (before fix) — Run 1, k6 reproduce-OPS-2204.js, 50 VUs / 2m (2s memory sampling)
THRESHOLDS: http_req_failed rate=57.14% (FAIL, threshold rate<0.05)
checks_succeeded: 42.85% (24 out of 56)
http_req_duration (all): avg=1m34s min=10.54s med=1m59s max=2m0s p(90)=2m0s p(95)=2m0s
http_req_duration {expected_response:true}: avg=1m1s min=10.54s med=58.93s max=1m57s p(90)=1m46s p(95)=1m55s
data_received: 867 MB
All 32 failures were client-side "request timeout" (k6's 120s cap), not 500s or resets.

Container state after this run: RestartCount=0, OOMKilled=false, continuous
uptime unchanged — the container survived, pinned at the memory ceiling.

Memory trace (2s sampling) during the run:
```
07:51:04  MEM=40.7MiB / 160MiB (25%)   heap=24.6M   (pre-load)
07:51:13  MEM=159.8MiB (99.9%)         heap=44.4M
07:51:32–07:53:10  MEM pinned 159.5–160MiB (~100%) for ~2 minutes  heap steady ~91.9M
07:53:21  MEM=112.4MiB (brief dip, GC)  heap=36.5M
07:53:35–07:54:26  MEM back up to 148–160MiB  heap ~35.7M
```

Single isolated request (no concurrency), for scale:
100,000 rows, 36,141,185 bytes (36.14MB), 361.4 bytes/row, 2.50s, full
memory recovery afterward (RSS back to ~27.66MiB). Confirms one caller alone
is cheap — concurrency is what drives RSS to the ceiling.

## Reproduction (before fix) — Run 2, same script/VUs, 1s memory sampling
THRESHOLDS: http_req_failed rate=99.92% (FAIL, threshold rate<0.05)
checks_succeeded: 0.07% (18 out of 24246)
http_req_duration (all): avg=192.36ms min=0s med=0s max=56.72s p(90)=484.63µs p(95)=2.85ms
http_req_duration {expected_response:true}: avg=25.23s min=4.62s med=24.81s max=56.72s p(90)=48.34s p(95)=56.09s
data_received: 666 MB
Most failures were near-instant (avg 192ms, med 0s) — a materially different
signature from Run 1's 120s timeouts, consistent with connection loss during
restarts rather than slow completion.

## Root cause investigation — docker events during Run 2 (ground truth, not sampled)
```
08:01:45.116  container oom     (0e913a9de218...)
08:01:45.417  container die     exitCode=137, execDuration=26s
08:01:45.767  container start
08:02:08.412  container oom
08:02:08.749  container die     exitCode=137, execDuration=23s
08:02:09.073  container start
```
Two kernel OOM-kills, 23 seconds apart, both SIGKILL (exitCode=137). This is
the ticket's "restarts over and over" — confirmed directly in Run 2, but NOT
in Run 1 under identical script/VUs/duration. Same underlying condition
(sustained RSS at the container's 160MB cap), non-deterministic outcome: a
race between allocation rate and GC/kernel reclaim rate, not a deterministic
crash-on-request-N.

`docker compose logs capacity-api` contains no in-app crash trace for either
run — the only line the app ever prints is the startup banner
(`capacity-api listening on :3000 ...`), repeated once per restart. A SIGKILL
gives the process no chance to log anything on the way out; the kills are
only provable via kernel-level `docker events`.

Memory/heap samples bracketing the kills (1s sampling, gaps reflect the
monitor's own curl/docker-stats probe stalling under event-loop saturation):
```
08:01:39.904  MEM=159.9MiB (99.95%) CPU=128%  heap=118.5M
08:01:43.633  MEM=151.6MiB (94.7%)  CPU=186%  heap=<no response>
  -- 08:01:45 OOM-kill #1, die, restart --
08:01:46.144  MEM=53.7MiB (33.6%)   CPU=132%  heap=118.1M
08:02:06.903  MEM=146MiB (91.3%)    CPU=203%  heap=<no response>
  -- 08:02:08 OOM-kill #2, die, restart --
08:02:09.455  MEM=66.7MiB (41.7%)   CPU=150%  heap=108.8M
```
Two findings from this trace:
1. `nodejs_heap_size_used_bytes` never explains the RSS — at the moment RSS
   pinned at 159.9MiB, tracked JS heap was only ~118M, a ~40MB gap consistent
   with memory held outside the tracked heap (mysql2 row/column buffers,
   large intermediate strings from JSON.stringify of a 100k-row array).
2. The monitoring probe itself (`curl /metrics`, `docker stats`) went
   unanswered in the seconds immediately preceding each kill — the
   single-threaded event loop was too saturated to service even a trivial,
   unrelated read. The app was effectively unresponsive before the kernel
   finished it off.

## Capacity math
Measured per-request payload: 100,000 rows × 361.4 bytes/row ≈ 36.14MB
(measured directly, not estimated).
Container ceiling: 160MB (mem_limit: 160m).
160MB / 36.14MB ≈ 4.4 — the container physically cannot hold more than ~4-5
full in-flight export payloads at once, before even counting Node's baseline
footprint (~27MB idle) or per-request overhead. At 50 concurrent VUs, demand
exceeds physical capacity by roughly 10-11x.

## Fix
Two changes in api/server.js and docker-compose.yml:

1. Rewrote GET /api/patients/export to cursor the table in bounded 1,000-row
   chunks via keyset pagination on the primary key
   (`WHERE id > ? ORDER BY id LIMIT ?`, not OFFSET, so each chunk stays an
   indexed range scan) and stream each chunk to the HTTP response with
   backpressure handling (checking res.write()'s return value, awaiting
   'drain' when the socket buffer is full), instead of materializing all
   ~100,000 rows and res.json()-ing them in one shot.

2. Fixed the NODE_OPTIONS/cgroup mismatch in docker-compose.yml: capped
   --max-old-space-size at 112MB (down from 256MB) — below the container's
   real 160MB limit instead of above it, leaving ~48MB (30%) headroom for
   non-heap overhead so V8's own allocation-failure handling can react before
   the kernel OOM-killer does.

mem_limit / deploy.resources.limits.memory deliberately left at 160M — not
raised, since that would move the ceiling rather than fix the capacity math.

## After fix — verification (single run; see Trade-off / limitation below)
k6 run against the rebuilt container (fresh process, RestartCount=0 before
the run), using a scratch copy of reproduce-OPS-2204.js with
`responseType: 'none'` added to the http.get() call — a client-side-only
change (k6 discards response bodies instead of buffering them) made because
the k6 process itself was being SIGKILLed by unrelated host memory/swap
pressure (Chrome/Zoom/other docker projects on the same host, swap at 100%),
not by anything server-side. load-tests/reproduce-OPS-2204.js itself was not
modified — confirmed via `git status` showing no diff there.

THRESHOLDS: http_req_failed rate=0.00% (PASS, threshold rate<0.05)
checks_succeeded: 100.00% (100 out of 100)
http_req_duration (all): avg=1m14s min=1m13s med=1m14s max=1m14s p(90)=1m14s p(95)=1m14s
http_req_failed: 0.00%
data_received: 3.6 GB (100 requests x ~36MB, full exports)
vus: 50 (min=50, max=50)

Container state: RestartCount=0, OOMKilled=false throughout.

Prometheus check: http_requests_total{route="/api/patients/export",status_code="200"}
incremented cleanly; db_errors_total showed no entries for this route.

Memory trace (1s sampling) during the run:
```
08:42:38  MEM=57.5MiB (36%)    CPU=0.8%    heap=21.3M   (pre-load)
08:42:46  MEM=126.7MiB (79.2%) CPU=155%    heap=90.1M   (ramp-up)
08:42:48–08:43:58  MEM steady ~124-129MiB (77-80%)      heap ~65-86M
08:44:00–08:45:11  MEM steady ~103-106MiB (64-66%)      heap ~47-64M
08:45:13  MEM=103MiB, CPU drops to 47% then <1%          (requests draining)
08:45:21–08:45:25  MEM back to ~55.5-56MiB (idle)        heap ~17.2-17.7M
```
Peak observed RSS: 128.7MiB (80.34%) at 08:43:48 — never approached the
160MB cap, ~31MB of headroom maintained throughout.

## Before -> After summary

| Metric | Pre-fix Run 1 | Pre-fix Run 2 | Post-fix (this run) |
|---|---|---|---|
| Errors | 57.14% (32/56) | 99.92% (24228/24246) | 0.00% (0/100) |
| Restarts | 0 | 2 (23s apart) | 0 |
| OOMKilled | false | — (SIGKILL via cgroup oom, exitCode=137) | false |
| Peak RSS | 159.5-160MiB (pinned ~100%) | 159.9MiB (pinned ~100%) | 128.7MiB (80.3%), never pinned |
| Avg / p95 request duration | timeouts at 120s cap | avg 25.23s (successful), p95 56.09s | avg/p95 ≈ 1m14s (74s) |
| Data received | — | 666 MB | 3.6 GB (100 x 36MB, full exports) |

## Root cause & mechanism

`/api/patients/export` ran `SELECT * FROM patients` with no LIMIT,
pagination, or streaming, materializing the entire ~100,000-row table
(~36.14MB, measured) as one in-memory array and serializing it in a single
synchronous JSON.stringify via res.json(). Under 50 concurrent exporters, up
to 50 of these ~36MB payloads could be resident at once against the
container's 160MB cgroup cap — demand exceeding physical capacity by
~10-11x. Whether the process survived at the ceiling was a race between
allocation rate and GC/kernel reclaim rate, not deterministic: identical
script/VUs/duration produced 0 restarts once (Run 1) and 2 SIGKILL/OOM
restarts 23s apart the next time (Run 2). The NODE_OPTIONS mismatch
(--max-old-space-size=256 against a 160MB cgroup limit) compounded this by
letting V8 believe it had headroom the kernel would never grant, removing
V8's own chance to self-limit before the kernel intervened.

The streaming/cursor rewrite bounds memory to O(chunk size) instead of
O(table size), eliminating the OOM-kills. The binding constraint moved to
connectionLimit: 2 in api/database.js — each export now needs ~101
sequential DB round trips (1 count query + 100 chunk queries), so 50
concurrent exporters funneled through 2 connections serializes hard,
producing the ~74s-per-request duration observed post-fix.

## Trade-off / limitation discovered

**connectionLimit: 2 is now the binding constraint for this endpoint.**
Post-fix, every export request completes successfully with 0 errors and 0
restarts, but takes ~74 seconds due to serializing ~101 DB round trips
through only 2 connections. This is a strict availability improvement over
pre-fix behavior (bounded, predictable latency and zero errors, instead of a
coin-flip between "survives pinned at the cap" and "OOM-killed, restarts,
57-99% of requests fail") but 74s/export is not itself a good number.
Raising/tuning connectionLimit for this access pattern is flagged as
follow-up scope, not fixed here — a distinct capacity dimension (connection
throughput) from the one this incident was about (memory), and changing pool
size without isolating it first already backfired twice (OPS-2201, OPS-2202)
in this codebase.

**Single verification run, not two as originally planned.** A second
post-fix run was planned to confirm the fix under repeated trials (matching
how the pre-fix behavior was itself non-deterministic run-to-run) but was
not executed due to time constraints. One clean post-fix run is supporting
evidence the fix works, not proof it eliminates the failure mode with
certainty across all conditions.

**Testing-environment complication, not a server-side finding:** during
verification, the k6 test client itself was SIGKILLed twice by the host's
own OOM-killer (unrelated Chrome/Zoom/other-docker-project memory pressure,
host swap at 100% at the time), before responseType:'none' was added to a
scratch copy of the reproduction script to reduce k6's own memory footprint.
The container under test was unaffected both times (RestartCount stayed at
0) — this was purely a limitation of the test harness on a loaded desktop
host, documented here so it isn't mistaken for a server-side symptom.
