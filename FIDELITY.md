# FIDELITY.md — Where the lab differs from real production

Documented gaps between this lab's implementation and what a real 
production deployment would need. Each item lists what was done in the 
lab, why, and what would change in production.

## 1. /readyz probe pool isolation — too aggressive for real-world failures

**In the lab:**  
`api/database.js` maintains a separate probe pool (connectionLimit: 1) 
distinct from the main request-serving pool (connectionLimit: 2). This 
was an intentional design decision so that `/readyz` can continue running 
`SELECT 1` even when the main pool is under transient load — preventing 
readiness flapping during brief bursts.

**Real production impact (surfaced by OPS-2202 replay):**  
Under sustained overload (2000 concurrent VUs), the main pool completely 
saturated and returned EOF on 97.56% of requests, but `/readyz` continued 
returning 200 because the probe pool's dedicated connection stayed 
healthy. An ELB / nginx using `/readyz` as a health signal would keep 
routing traffic to a pod that cannot actually serve requests.

**What production would need:**  
A second readiness signal at the application layer — either:
- An alert on `rate(http_requests_total{status_code=~"5.."}) > threshold`
- An external synthetic prober hitting real business endpoints (not just 
  the health check) and reporting a `synthetic_probe_success` gauge
- OR change `/readyz` to include a rolling-window "recent 5xx rate" check

## 2. `db_errors_total` counter under-instrumented

**In the lab:**  
The `dbErrorsTotal` Prometheus counter is defined in `api/server.js` and 
the `DBErrorsSpike` alert targets `sum(rate(db_errors_total[1m])) > 0.5`. 
However, the counter is not called in the admit endpoint's catch block.

**Real production impact (surfaced by OPS-2203 replay):**  
Under 500 concurrent VUs racing on `POST /api/hospitals/1/admit`, 
99.76% of requests failed at HTTP layer (timeouts, EOFs) — but 
`db_errors_total` never incremented because the DB error path in the 
handler was never reached. The `DBErrorsSpike` alert cannot fire on this 
class of incident.

**What production would need:**  
Every DB touch point must wire the counter:
```js
try {
  await pool.query(...);
} catch (err) {
  dbErrorsTotal.inc({type: err.code || 'unknown'});
  throw err;
}
```
Ideally enforced via a code-review checklist or a wrapper function like 
`safeQuery(pool, sql, params)` that increments the counter automatically 
on failure.

## 3. Alert "for:" windows create PENDING vs FIRING evidence gaps

**In the lab:**  
Alert rules use conservative `for:` windows to avoid false alerts:
- `APIHighLatencyP95`: `for: 2m`
- `APIReadinessDegraded`: `for: 30s`
- `DBErrorsSpike`: `for: 2m`
- `APIMemoryNearContainerLimit`: `for: 1m`

**Real production impact (surfaced by OPS-2201 and OPS-2204 replays):**  
When load bursts are shorter than the `for:` window, alerts reach 
PENDING state but not FIRING. For OPS-2201 (200 VU x 30s repeated 4 
times), the load pattern was too intermittent for the 2m continuous 
breach requirement. For OPS-2204 (50 VU x 2m), memory climbed to 90% 
of cap but the recovery happened within 5s of the eval window closing.

**What production would prefer:**  
Different `for:` windows depending on operational preference:
- **Fast paging:** for: 30s on critical alerts (accept some false 
  positives for early warning)
- **Fewer wakeups:** for: 5m+ (only alert on sustained issues, accept 
  slower response)
- **Multi-window / burn-rate alerts:** for both fast and slow error rates 
  (Google SRE pattern, more code complexity)

For a real production system, using a fast-warning alert (`for: 30s`) 
plus a slower confirming alert (`for: 5m`) on the same expression gives 
best of both.

## 4. LocalStack RDS was replaced with Aiven MySQL mid-lab

**In the lab:**  
Original plan called for RDS on LocalStack. Instructor moved to Aiven 
MySQL (external, TLS-required, free tier) partway through. `modules/data` 
in the group repo (`regional-health-platform`) was rewritten to reflect 
this — no longer provisions a DB, just publishes caller-supplied Aiven 
connection details to Secrets Manager.

**What production would need:**  
- If sticking with Aiven: the current design works; each service gets 
  its own Aiven instance, credentials rotate via Secrets Manager
- If moving to real RDS: the same `modules/data` module could be extended 
  to also create an `aws_db_instance` and populate the same Secrets 
  Manager envelope from its outputs, keeping the app code unchanged

## 5. Rotated secrets need a process restart

**In the lab:**  
`api/secrets.js` caches DB credentials at boot via `loadDbCredentials()`. 
There's no refresh mechanism — once cached, the values are used for the 
process lifetime.

**Real production impact:**  
If Aiven rotates the DB password (or the operator rotates it manually 
for security reasons) but the app is not restarted, all new pool 
connections will fail authentication. The `/readyz` probe will correctly 
detect this (probe pool query fails), but recovery requires a container 
restart.

**What production would need:**  
Either:
- A periodic re-fetch (every N minutes) with pool recreation on change
- SIGHUP handler that triggers reload
- Deployment pipeline that restarts pods after rotating secrets

## 6. Node 20 with AWS SDK deprecation warning

**In the lab:**  
The container runs Node 20 (base image `node:20-slim` pinned by digest). 
`@aws-sdk/client-secrets-manager` v3 emits a deprecation warning at boot: 
future SDK versions (published after Jan 2027) will require Node 22+.

**What production would need:**  
Bump the base image to `node:22-slim` before Jan 2027 to avoid falling 
off the supported SDK track. Non-urgent — the current setup works and 
the deadline is months away.
