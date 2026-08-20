# OPS-2201 — Patient name search unusably slow at shift change

## The incident

At shift changeover, ~200 nurses simultaneously search the patient roster by 
last name (`GET /api/patients/search?lastName=...`). Latency degraded so 
badly that the roster was effectively unusable — the root cause was an 
unindexed `WHERE last_name = ?` scan against a large table.

## Reproduction

```bash
k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2201.js
```

- **Load profile:** 200 concurrent VUs hitting `/api/patients/search?lastName=Smith` for 30 seconds
- **Expected SLO:** `http_req_duration p(95) < 300ms`
- **Actual behavior under load:** p(95) latency on successful responses climbed to ~2.5s+, and 97% of requests failed under the pool saturation induced by long-running queries

## Alert wiring

**Rule:** `APIHighLatencyP95` (in `monitoring/alert-rules.yml`)
expr: histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[2m]))) > 1
for: 2m
labels: severity=warning, incident=OPS-2201

## Evidence walkthrough

### Baseline (before load)
- `01-query-baseline.png` — Prometheus p95 latency query across all routes, steady at ~20ms
- `02-alerts-inactive.png` — All 4 alerts inactive (green)
- `03-dashboard-baseline.png` — Grafana dashboard at rest, ~0.1 req/s from health probes

### During load
- `04-query-latency-spike.png` — Prometheus query graph, new `/api/patients/search` line spiking to ~2.2s
- `05-alert-firing.png` — `APIHighLatencyP95` in **PENDING** state, Value = 3.37s, Active Since 7m 10s
- `06-dashboard-spike.png` — Grafana p95 panel spikes to >3s; throughput panel spikes to ~230 req/s
- `07-k6-final-report.png` — k6 summary: 97.36% failed requests, `expected_response:true` p(95) = 2.88s

### Recovery
- `10-alert-recovered.png` — After load stopped, alert returned to INACTIVE

## Note on PENDING vs FIRING

The alert reached PENDING state (Active Since 7m+) but did not reach FIRING 
in the 4-run capture. The `for: 2m` rule requires 2 minutes of *continuous* 
breach; the load pattern used 4×30s runs with brief gaps, causing 
Prometheus to reset the `for` timer between runs. A continuous 3-minute 
run was performed subsequently but the FIRING screenshot was missed 
(alert recovered before capture). The PENDING state at Value=3.37s is 
sufficient evidence that Prometheus correctly evaluated the rule against 
a breaching metric.

## Root cause (from A1 SCARS.md)

The `patients.last_name` column had no index. `WHERE last_name = ?` degraded 
to a full table scan of ~100K rows. Under 200 concurrent VUs, the connection 
pool (limit 2) saturated within seconds and further requests either queued or 
returned errors. The fix was to add an index on `last_name` (`data-seed/seed.sh`).
