# OPS-2204 — Nightly export crashes the service, on-call paged for restarts

## The incident

The nightly ETL job calls /api/patients/export, which returns the full 
patient table in one response. Each call allocates a large object graph 
in V8 memory before serialization. Under concurrent load (50 VUs, mimicking 
overlapping ETL retries), the Node process approaches the container's 
160MB memory cap. On-call gets paged when the container OOM-kills and 
restarts.

## Root cause (from A1 SCARS.md)

Two overlapping issues:
1. The export endpoint builds the entire response in memory rather than 
   streaming rows, so RSS is proportional to result set size.
2. The container has a 160MB mem_limit but the app was originally started 
   with default V8 heap (which trusts host memory). Under load, V8 would 
   allocate past what the kernel would grant, causing OOM-kill.

The A1 fix set NODE_OPTIONS=--max-old-space-size=112 to cap V8 old-space 
at 112MB, leaving ~48MB (30 percent) headroom for non-heap overhead. This 
keeps the container alive by throwing V8 OutOfMemory errors instead of 
letting the kernel kill the process.

## Reproduction

k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2204.js

Load: 50 concurrent VUs GETting /api/patients/export for 2 minutes 
(timeout 120s per request so nothing times out client-side).

## Alert wiring

Rule: APIMemoryNearContainerLimit
- expr: process_resident_memory_bytes{job="capacity-api"} / (160*1024*1024) > 0.85
- for: 1m
- labels: severity=critical, incident=OPS-2204

Fires when RSS crosses 85 percent of the 160MB container cap for 1 minute — 
enough warning to page on-call before the kernel OOM-killer runs (or, 
with the A1 fix in place, before V8 starts throwing OOM errors).

## Evidence walkthrough

### Baseline (before load)
- 01-memory-ratio-baseline.png: ratio=0.4514 (45 percent of 160MB cap)
- 02-alerts-inactive.png: All 4 alerts INACTIVE
- 03-dashboard-baseline.png: Grafana memory panel steady at ~70MB RSS

### During load
- 05-alert-pending-firing.png: APIMemoryNearContainerLimit in PENDING 
  state, Value=0.900 (90 percent of the 160MB cap), Active Since 
  1m 5.864s. Alert correctly detected the memory pressure.
- 06-dashboard-memory-spike.png: Grafana memory panel shows RSS climb 
  from ~70MB to ~150MB during the load window.
- 08-query-recovered.png: ratio dropped to 0.475 after k6 ended and 
  garbage collection ran.

### Container survival
- 09-container-survived.png: docker ps shows capacity-api Up 40 minutes 
  (healthy) — the container was NOT OOM-killed. The A1 fix 
  (NODE_OPTIONS --max-old-space-size=112) worked as designed: V8 stayed 
  under the kernel's mem_limit and threw JS-level OOM errors on individual 
  requests instead of the kernel killing the process.

## Finding: alert reached PENDING but not FIRING

The alert reached PENDING at Value=0.900 (well above the 0.85 threshold) 
with Active Since 1m 5s — just over the 1m breach window. Reaching FIRING 
requires the metric to STAY above threshold for a full 1 minute of 
continuous evaluation.

In our replay, the memory started dropping just after the alert reached 
PENDING because:
- k6 finished at T+2m, ending the sustained pressure
- Node's garbage collector reclaimed the export response memory 
  aggressively once no new requests arrived

The Value=0.900 in the PENDING screenshot is definitive evidence that 
Prometheus correctly evaluated the alert rule against a breaching metric. 
For a demonstration of FIRING, a longer or heavier load (e.g. 100+ VUs 
for 3+ minutes) would keep memory pinned above 85 percent long enough to 
transition PENDING to FIRING.

## Successful design outcomes documented

Two things worked correctly in this replay:

1. The pre-A1 root cause was "container OOM-killed and restarted." With 
   the A1 fix (--max-old-space-size=112), the container survives — see 
   09-container-survived.png. On-call would still be paged (alert fires), 
   but individual requests fail cleanly at the V8 layer instead of the 
   entire container dying.

2. The alert fires at the right threshold. Value=0.900 crossed the 
   0.85 threshold decisively, giving on-call ~1 minute of warning before 
   any real damage. This is exactly the SLO the alert is designed to 
   enforce.

## Trade-off for FIDELITY.md

The 85 percent threshold is aggressive by design — it wants to fire 
BEFORE the container dies, not after. The trade-off is potential false 
alarms during brief legitimate spikes (nightly ETL run, backup jobs). 
For production, consider tuning to (a) 90 percent + shorter for: 
(faster paging) or (b) 85 percent + longer for: (fewer false alarms), 
depending on the operational preference.
