# OPS-2203 Evidence

## Baseline (healthy system)
p95 latency: 24.68ms, RPS: 49.37, Error rate: 0.00%

## Reproduction (before fix) — k6 reproduce-OPS-2203.js, 500 VUs / 30s
THRESHOLDS: http_req_failed rate=99.84% (FAIL, threshold rate<0.05)
checks_succeeded: 0.15% (97 out of 64355)
http_req_duration overall: p95=162ms (fast -- most requests fail quickly)
http_req_duration {expected_response:true}: p95=57.12s (successes are extremely slow)
max latency: 59.58s -- matches MySQL's default innodb_lock_wait_timeout (50s) + overhead

## Root cause investigation — SHOW ENGINE INNODB STATUS during surge
Captured mid-surge via:
  (k6 run ... &) ; sleep 5 ; docker compose exec mysql-db mysql ... -e "SHOW ENGINE INNODB STATUS\G"

Key excerpt:
  ---TRANSACTION 2423, ACTIVE 0 sec starting index read
  LOCK WAIT 2 lock struct(s), heap size 1128, 1 row lock(s)
  MySQL thread id 5755 ... query id 107124 172.21.0.4 root updating
  UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = 1
  ------- TRX HAS BEEN WAITING 0 SEC FOR THIS LOCK TO BE GRANTED:
  RECORD LOCKS space id 3 page no 4 n bits 72 index PRIMARY of table
  capacity_lab.hospitals trx id 2423 lock_mode X locks rec but not gap waiting

Confirms a row-level exclusive (X) lock on the hospitals row (id=1).
Every admission takes this lock via UPDATE; only one transaction can hold
it at a time. This is CORRECT database behavior (prevents double-decrementing
the same bed count) -- the question is why the lock is held so long.

## Code inspection — the actual bottleneck

api/server.js, /api/hospitals/:id/admit handler (before fix):
  await conn.beginTransaction();
  await conn.query('UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = ?', [hospitalId]);
  await notifyBedRegistry(hospitalId);   // <-- INSIDE the transaction
  await conn.commit();

notifyBedRegistry implementation:
  function notifyBedRegistry(_hospitalId) {
    return new Promise((r) => setTimeout(r, 500));
  }

The exclusive row lock is held for the ENTIRE 500ms simulated registry call,
not just the near-instant UPDATE. Every other admission to the same hospital
must wait behind this lock.

## Capacity math

Lock hold time per admission ~ 500ms (dominated by notifyBedRegistry; the
UPDATE itself is single-digit ms).

Max serialized throughput for ONE hospital row = 1 / 0.5s = 2 admissions/sec,
regardless of concurrency. More VUs cannot raise this ceiling -- they only
grow the queue behind the lock, and queued transactions eventually hit
MySQL's innodb_lock_wait_timeout (default 50s) and fail with a lock wait
timeout error. This matches the observed max latency of ~59.5s (50s timeout
+ overhead) and explains why different hospitals were largely unaffected by
each other (different rows = different locks = no contention).

## Fix

Moved notifyBedRegistry() to AFTER conn.commit(), fire-and-forget, so the
row lock is released as soon as the UPDATE is committed instead of being
held through an unrelated 500ms external call:

  await conn.commit();
  res.json({ status: 'admitted', hospitalId });
  notifyBedRegistry(hospitalId).catch(() => {});

Design trade-off: the client no longer waits on (or is informed of) registry
notification failures, since the admission itself is already safely committed
by the time the registry call happens. This is intentional -- the registry
notification is a side effect, not part of the correctness-critical write.

## After fix — verification

### At realistic concurrency (20 VUs / 15s, closer to a real same-hospital surge):
THRESHOLDS: both PASS
  http_req_duration p(95)=221.62ms  (PASS, threshold p95<1000ms)
  http_req_failed rate=0.00%        (PASS, threshold rate<0.05)
checks_succeeded: 100.00% (1590 out of 1590)

### At extreme concurrency (500 VUs / 30s, same as original repro):
No more 50-60s lock-wait timeouts (the lock fix works -- lock hold time
dropped from ~500ms to ~ms per admission). However, at this concurrency
level a DIFFERENT bottleneck surfaces: connection resets / EOF errors,
the same signature diagnosed in OPS-2202 (connectionLimit: 2 pool +
TCP listen backlog exhaustion at very high concurrency). This is a
pre-existing, already-documented structural limit of this codebase's
connection handling, not a new bug introduced by this fix.

## Before -> After summary (at 20 VUs, realistic same-hospital surge)

| Metric | Before (est. from 500-VU data) | After (20 VUs) |
|---|---|---|
| p95 latency | 57.12s (successful reqs) | 221.62ms |
| Error rate | 99.84% | 0.00% |
| Max single-hospital throughput | ~2 admissions/sec (hard ceiling) | no longer bounded by this lock |

## Root cause & mechanism

Row-level exclusive locking on the hospitals table is correct and necessary
for consistency -- it is not itself a bug. The bug was holding that lock for
500ms per transaction by performing an unrelated external notification call
BEFORE commit instead of after. Since only one transaction can hold an
exclusive lock on a given row at a time, this capped the entire hospital's
admission throughput at 1/0.5s = 2/sec no matter how much hardware or
concurrency was thrown at it -- a hard serialization ceiling, not a
degradation curve. Concurrent admissions queued behind the lock and
timed out en masse once wait time exceeded innodb_lock_wait_timeout (50s).

## Trade-off / limitation discovered

At very high concurrency (500 VUs), fixing the lock issue exposes the
SAME connection-pool/TCP-backlog constraint found in OPS-2202 -- this
codebase's connectionLimit: 2 and lack of a reverse-proxy admission layer
is a recurring structural weak point across multiple tickets, not specific
to any one endpoint. Worth flagging in the synthesis section as a
cross-cutting fix candidate rather than a per-ticket patch.
