# OPS-2202 — Whole app freezes during registration surges (but DB looks idle)

## The incident

At registration surges (up to 2000 concurrent requests over 30 seconds), 
the app effectively freezes: 97.5% of requests either time out or return 
EOF from the server. Yet the database itself remains idle — the bottleneck 
is not the DB engine.

## Root cause (from A1 SCARS.md)

Node.js MySQL pool `connectionLimit: 2`. Under 2000 concurrent VUs, every 
new request must wait for one of two connections. The server accepts 
sockets but request handlers block waiting for a pool connection that 
never comes; clients eventually get EOF as the server closes sockets under load.

## Reproduction
k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2202.js

Load: ramping-vus 0 to 2000 over 5s, hold 2000 VUs for 25s, graceful stop 5s.
Hits GET /api/patients/recent (trivial query; the bottleneck is the pool, not the query).

## Alert wiring

Rule: APIReadinessDegraded
- expr: capacity_api_ready == 0
- for: 30s
- labels: severity=critical, incident=OPS-2202

The capacity_api_ready gauge is set inside /readyz: 1 when the health check 
passes, 0 when any of: boot-time secret load failed, HTTP concurrency 
saturated, DB pool saturated, or probe pool query timed out.

## Evidence walkthrough

### Baseline
- 01-readyz-gauge-baseline.png: capacity_api_ready = 1
- 02-alerts-inactive.png: All 4 alerts INACTIVE
- 03-readyz-ready-loop.png: curl loop steady on ready + http 200

### During load
- 04-k6-mid-run-eof-errors.png: mass EOF errors from server
- 05-alerts-still-inactive.png: Prometheus Alerts still INACTIVE (see finding)
- 06-dashboard-spike.png: Grafana throughput spike on /api/patients/recent
- 07-k6-final-report.png: 97.56 percent failed, http_req_failed threshold FAILED
- 08-gauge-stayed-1.png: capacity_api_ready stayed at 1 throughout
- 09-readyz-loop-during-load.png: curl loop kept returning ready http 200

## Finding: /readyz design isolation prevented alert firing

The alert APIReadinessDegraded did NOT fire during this incident. This is 
a real design finding, not a bug.

The /readyz implementation (see api/database.js) uses a separate probe 
pool with its own dedicated connection, distinct from the main request-
serving pool. This isolation means:

- Good: /readyz stays responsive under transient main-pool saturation — 
  the probe pool's dedicated connection can always run SELECT 1.
- Bad: capacity_api_ready stays at 1 even when the main pool is effectively 
  unusable. An LB using /readyz would keep routing traffic to a failing instance.

isPoolSaturated() reads mysql2 internals but only returns true when 
busy >= connectionLimit OR queued > 0. Under this incident's ramp pattern, 
counters may transition too quickly for the gauge (only updated during 
/readyz hits) to catch.

## Trade-off for FIDELITY.md

The design decision to isolate the probe pool from main-pool saturation was 
intentional. For sustained overload, /readyz should probably factor in an 
application-level failure metric (e.g., percent of recent 5xx responses) 
rather than just DB reachability.

For this lab, APIReadinessDegraded reliably detects the "secret rotation" 
and "DB truly gone" failure modes (C4), but does not detect pure pool 
exhaustion (OPS-2202). Production hardening would add a second alert on 
rate(http_requests_total{status_code=~"5.."}) or use an external synthetic prober.
