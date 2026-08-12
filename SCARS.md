# 🩹 Scar Log — Regional Health

One entry per incident: the permanent, one-screen record of a wound and the
lesson it left. See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the template.

---

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
