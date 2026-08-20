# Evidence — A2 Rehosting Capacity Lab

Evidence artifacts for C1-C9 assignment requirements.

## Structure

### `06-observability/` — Baseline monitoring stack (C6)

- `prometheus-rules-loaded.png` — All 4 alert rules loaded from 
  monitoring/alert-rules.yml at Prometheus boot
- `prometheus-targets-up.png` — Prometheus successfully scraping 
  capacity-api and itself
- `prometheus-alerts-inactive.png` — All 4 alerts INACTIVE at rest
- `grafana-datasource-prometheus.png` — Prometheus datasource provisioned 
  successfully in Grafana
- `grafana-dashboard-baseline.png` — Capacity Lab dashboard rendering 4 
  panels with real data

### `07-incidents/` — Incident replay evidence (C7)

Each incident has: 3 baseline screenshots + during-load evidence + 
findings README explaining what was observed and any trade-offs for 
FIDELITY.md.

| Incident | Alert | Outcome |
|---|---|---|
| OPS-2201 | APIHighLatencyP95 | PENDING at Value=3.37s (>1s threshold) |
| OPS-2202 | APIReadinessDegraded | Did NOT fire — probe-pool isolation finding |
| OPS-2203 | DBErrorsSpike | Did NOT fire — instrumentation gap finding |
| OPS-2204 | APIMemoryNearContainerLimit | PENDING at Value=0.900 (>0.85 threshold), container survived per A1 fix |

## How to reproduce

Each incident's README lists the exact `k6 run` command. Prerequisites:
docker compose up -d
sleep 15
curl -s http://localhost:3003/readyz # confirm ready

Open dashboards:
- Prometheus: http://localhost:9091
- Grafana:    http://localhost:3002

Then run any of:
k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2201.js
k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2202.js
k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2203.js
k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2204.js

Alert timing: OPS-2201, 2203, 2204 all use "for: 2m" or "for: 1m", so 
scripts with the default 30s duration may not reach FIRING state. See 
individual incident READMEs for notes on where longer runs were used and 
where PENDING at breaching Value is treated as sufficient evidence.

## Key findings (feeding into FIDELITY.md)

1. **Probe pool isolation is too effective for OPS-2202** — /readyz 
   remains green even when the main pool is 97% dropping requests. 
   Production would need a second alert on 5xx rates.

2. **db_errors_total counter is under-instrumented** — exists but not 
   called from admit endpoint catch blocks. Alert cannot fire on 
   OPS-2203-style failures until catch blocks are wired.

3. **A1 memory fix works as intended** — with 
   --max-old-space-size=112, the container survives OPS-2204 rather than 
   OOM-killing. Alert still fires at 85% to give on-call warning.

4. **Alert "for:" windows** — OPS-2201's for: 2m and OPS-2204's for: 1m 
   sometimes cause PENDING vs FIRING confusion when load bursts are 
   shorter than the eval window. This is by design (avoids false alerts 
   on transient spikes) but affects replay evidence style.
