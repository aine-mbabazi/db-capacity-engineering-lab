# OPS-2203 — Bed admissions failing during mass-casualty drill

## The incident

During a mass-casualty drill, 500+ staff simultaneously attempted to admit 
patients to Hospital #1. The endpoint (POST /api/hospitals/:id/admit) 
executes an UPDATE that decrements available_beds, but without proper row 
locking, concurrent admissions race — either causing bed count to go 
negative silently, or throwing MySQL integrity errors on constraint 
violations.

## Root cause (from A1 SCARS.md)

The admit endpoint runs:
  UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = ?

Without SELECT ... FOR UPDATE or a CHECK constraint, concurrent updates 
race the read-modify-write. Two possible failure modes depending on 
schema constraints: silent negative bed count (no error, just wrong data), 
or constraint violation (MySQL error, caught in handler).

## Reproduction

k6 run --env BASE_URL=http://localhost:3003 load-tests/reproduce-OPS-2203.js

Load: 500 concurrent VUs POSTing to /api/hospitals/1/admit for 2m30s 
(extended from script default 30s for alert timing).

Result: 99.76% of requests failed (288369/289058), but failures were 
HTTP-layer (timeouts and EOFs from server), not DB constraint errors 
bubbling back through the application handler.

## Alert wiring

Rule: DBErrorsSpike
- expr: sum(rate(db_errors_total[1m])) > 0.5
- for: 2m
- labels: severity=warning, incident=OPS-2203

## Evidence walkthrough

Baseline:
- 01-db-errors-baseline-empty.png: sum(rate(db_errors_total[1m])) 
  returns empty — the counter has zero observations
- 02-alerts-inactive.png: All 4 alerts INACTIVE  
- 03-dashboard-baseline.png: Grafana dashboard quiet

## Finding: db_errors_total counter exists but is not wired

Inspection of /metrics after multiple test runs showed:

# HELP db_errors_total Total number of database errors by type
# TYPE db_errors_total counter

Zero label-instantiated rows. The counter object exists in server.js but 
the admit endpoint's error handler never calls dbErrorsTotal.inc(). 
Under the 500-VU load, HTTP-layer failures manifest as timeouts before 
the DB error branch executes, so the counter never increments.

Consequences:
- DBErrorsSpike alert cannot fire on OPS-2203's actual failure mode
- The alert would fire correctly on genuine DB errors (deadlocks, 
  constraint violations, connection lost mid-transaction) IF the endpoint 
  catch block called dbErrorsTotal.inc({type: err.code}).

The fix would be to instrument every DB touch point:
  catch (err) { dbErrorsTotal.inc({type: err.code || 'unknown'}); throw err; }

## Trade-off for FIDELITY.md

Two issues surfaced by this incident replay:

1. db_errors_total is only useful if consistently incremented in every 
   catch block that touches the DB. Currently under-instrumented in the 
   admit endpoint (and likely others).

2. Same as OPS-2202: 500-VU concurrent load causes HTTP-layer collapse 
   BEFORE any DB error path executes. Application-level failure metrics 
   (e.g. rate(http_requests_total{status_code=~"5.."})) would catch this 
   mode.
