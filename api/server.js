'use strict';

/**
 * server.js
 * -----------------------------------------------------------------------------
 * Express API for the Regional Health admissions & patient-lookup service.
 *
 * Endpoints:
 *   GET  /api/patients/recent        Recent patients widget
 *   GET  /api/patients/search        Patient lookup by last name
 *   POST /api/hospitals/:id/admit    Admit a patient (decrement bed count)
 *   GET  /api/patients/export        Full patient export for the analytics team
 *   GET  /api/audit/ping             Mongo audit-store health probe
 *   GET  /metrics                    Prometheus metrics
 *   GET  /healthz                    Liveness: process is up
 *   GET  /readyz                     Readiness: DB reachable, pool not
 *                                     saturated, secret resolved at boot
 *   GET  /debug/secret-source        Which secret (arn/versionId) is loaded
 */

const express = require('express');
const client = require('prom-client');
const { getPool, getProbePool, isPoolSaturated, getMongo, initPool } = require('./database');
const { getSecretSource } = require('./secrets');

const app = express();
app.use(express.json());
const MAX_CONCURRENT_REQUESTS = 100;
let inFlight = 0;
app.use((req, res, next) => {
  if (inFlight >= MAX_CONCURRENT_REQUESTS) {
    return res.status(503).json({ error: 'SERVER_BUSY', message: 'Too many concurrent requests' });
  }
  inFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; inFlight--; } };
  res.on('finish', release);
  res.on('close', release);
  next();
});

const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new client.Registry();
register.setDefaultLabels({ app: 'capacity-api' });

// Default process/GC/heap metrics.
client.collectDefaultMetrics({ register, gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5] });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const dbErrorsTotal = new client.Counter({
  name: 'db_errors_total',
  help: 'Total number of database errors by type',
  labelNames: ['route', 'code'],
  registers: [register],
});

// Per-request timing + counting middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.baseUrl + req.route.path : req.path;
    const labels = { method: req.method, route, status_code: res.statusCode };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  next();
});

// ---------------------------------------------------------------------------
// Health & metrics
//
// /health is kept as-is (existing consumers may already poll it) and
// /healthz is added alongside it as the same trivial liveness check, so
// nothing that already depends on /health breaks.
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

const READYZ_QUERY_TIMEOUT_MS = 1000;

// Readiness = can this instance actually serve a request right now:
//   1. the boot-time secret load succeeded (getSecretSource().arn is set -
//      see secrets.js, which sets it to null on failure),
//   2. the HTTP-layer concurrency gate isn't already maxed out (same
//      inFlight/MAX_CONCURRENT_REQUESTS counter the limiter middleware
//      above uses),
//   3. the DB pool itself isn't saturated (distinct failure mode from #2 -
//      see isPoolSaturated()'s doc comment in database.js),
//   4. a trivial query actually completes within a short timeout, run on a
//      dedicated probe pool (not the main pool - see database.js) so this
//      check never queues behind real traffic. MAX_EXECUTION_TIME(1000)
//      asks MySQL to kill the query server-side if it's stuck; the
//      Promise.race is a client-side safety net for the case where the
//      connection itself is stuck below the query layer (network hang)
//      and the server-side hint never gets a chance to apply - between the
//      two, nothing is left holding an orphaned query on either side. Also
//      catches initPool() not having finished yet, since getProbePool()
//      throws until then.
app.get('/readyz', async (_req, res) => {
  const reasons = [];

  if (!getSecretSource().arn) {
    reasons.push('secret not resolved');
  }

  if (inFlight >= MAX_CONCURRENT_REQUESTS) {
    reasons.push('http concurrency saturated');
  }

  try {
    if (isPoolSaturated()) {
      reasons.push('db pool saturated');
    }
  } catch (err) {
    reasons.push(`db pool not reachable: ${err.message}`);
  }

  try {
    const probePool = getProbePool();
    await Promise.race([
      probePool.query('SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1'),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('query timed out')), READYZ_QUERY_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    reasons.push(`db not reachable: ${err.message}`);
  }

  if (reasons.length > 0) {
    return res.status(503).json({ status: 'not ready', reasons });
  }
  res.json({ status: 'ready' });
});

// What secret (if any) is actually loaded right now - arn + versionId only,
// never credential values. This is what C8's `make verify` checks.
app.get('/debug/secret-source', (_req, res) => {
  res.json(getSecretSource());
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Recent patients widget
// ---------------------------------------------------------------------------
app.get('/api/patients/recent', async (_req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM patients ORDER BY id DESC LIMIT 50'
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    dbErrorsTotal.inc({ route: '/api/patients/recent', code: err.code || 'UNKNOWN' });
    res.status(500).json({ error: err.code || 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Patient lookup by last name
// ---------------------------------------------------------------------------
app.get('/api/patients/search', async (req, res) => {
  const lastName = req.query.lastName || '';
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, first_name, last_name, diagnosis FROM patients WHERE last_name = ? LIMIT 50',
      [lastName]
    );
    res.json({ count: rows.length, lastName, data: rows });
  } catch (err) {
    dbErrorsTotal.inc({ route: '/api/patients/search', code: err.code || 'UNKNOWN' });
    res.status(500).json({ error: err.code || 'ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admit a patient to a hospital (decrement available beds).
// We update the bed count, then notify the regional bed registry that the
// count changed before finalizing, so the two systems stay consistent.
// ---------------------------------------------------------------------------
app.post('/api/hospitals/:id/admit', async (req, res) => {
  const hospitalId = Number(req.params.id);
  const pool = getPool();
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    await conn.query(
      'UPDATE hospitals SET available_beds = available_beds - 1 WHERE id = ?',
      [hospitalId]
    );


    await conn.commit();
    res.json({ status: 'admitted', hospitalId });
    notifyBedRegistry(hospitalId).catch(() => {});
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
    }
    dbErrorsTotal.inc({ route: '/api/hospitals/:id/admit', code: err.code || 'UNKNOWN' });
    res.status(500).json({ error: err.code || 'ERROR', message: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// Stand-in for the external registry client used by the admit flow.
function notifyBedRegistry(_hospitalId) {
  return new Promise((r) => setTimeout(r, 500));
}

const EXPORT_CHUNK_SIZE = 1000;

// ---------------------------------------------------------------------------
// Full patient export for the analytics/ETL team.
//
// OPS-2204 fix: the old version ran `SELECT * FROM patients` with no LIMIT,
// building the entire ~100,000-row result (~36MB, measured) as one in-memory
// array, then JSON.stringify'd it in one shot via res.json(). Under N
// concurrent exporters that's N x ~36MB of simultaneous in-flight payload,
// which blew past the container's 160MB cgroup cap and got the process
// SIGKILLed by the kernel OOM-killer (see LAB_JOURNAL.md / SCARS.md).
//
// This version cursors through the table in bounded chunks (keyset
// pagination on the primary key `id`, not OFFSET, so each chunk stays an
// indexed range scan no matter how deep) and streams each chunk to the HTTP
// response as it's fetched. Memory stays O(EXPORT_CHUNK_SIZE) - one chunk's
// worth of rows - regardless of table size or how many exports run at once.
// ---------------------------------------------------------------------------
app.get('/api/patients/export', async (_req, res) => {
  try {
    const pool = getPool();
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM patients');
    const total = countRows[0].total;

    res.set('Content-Type', 'application/json');
    res.write(`{"count":${total},"data":[`);

    let lastId = 0;
    let first = true;

    for (;;) {
      const [rows] = await pool.query(
        'SELECT * FROM patients WHERE id > ? ORDER BY id LIMIT ?',
        [lastId, EXPORT_CHUNK_SIZE]
      );
      if (rows.length === 0) break;

      const chunkJson = rows.map((r) => JSON.stringify(r)).join(',');
      const ok = res.write((first ? '' : ',') + chunkJson);
      first = false;
      if (!ok) {
        // Backpressure: wait for the socket buffer to drain before pulling
        // the next chunk from MySQL, so a slow client can't make us buffer
        // the whole export in Node's memory anyway.
        await new Promise((resolve) => res.once('drain', resolve));
      }

      lastId = rows[rows.length - 1].id;
      if (rows.length < EXPORT_CHUNK_SIZE) break;
    }

    res.end(']}');
  } catch (err) {
    dbErrorsTotal.inc({ route: '/api/patients/export', code: err.code || 'UNKNOWN' });
    if (res.headersSent) {
      // Body already started streaming; can't send a clean JSON error now -
      // end the connection so the client sees a truncated response rather
      // than hanging.
      res.end();
    } else {
      res.status(500).json({ error: err.code || 'ERROR', message: err.message });
    }
  }
});

// ---------------------------------------------------------------------------
// Mongo audit-store health probe
// ---------------------------------------------------------------------------
app.get('/api/audit/ping', async (_req, res) => {
  try {
    const db = await getMongo();
    const result = await db.command({ ping: 1 });
    res.json({ mongo: result });
  } catch (err) {
    res.status(500).json({ error: 'MONGO_ERROR', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Boot
//
// Secret + pool init happens once here, before we start accepting traffic,
// so every route's synchronous getPool() call is safe and /readyz's boot-
// time secret check has something to report from the moment the process is
// listening.
// ---------------------------------------------------------------------------
initPool()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`capacity-api listening on :${PORT} (metrics at /metrics)`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[boot] failed to initialize DB pool: ${err.message}`);
    process.exit(1);
  });
