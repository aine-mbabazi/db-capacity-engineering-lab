'use strict';

/**
 * database.js
 * -----------------------------------------------------------------------------
 * Connection factories for MySQL and MongoDB.
 */

const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const { loadDbCredentials } = require('./secrets');

// ---------------------------------------------------------------------------
// Environment configuration (with defaults for local runs)
// ---------------------------------------------------------------------------

// Pool-size/timeout settings are unrelated to *which* DB we're pointed at,
// so they stay static here. host/user/password/database/port now come from
// secrets.js (Secrets Manager, or MYSQL_* env vars as its own fallback)
// instead of being read from MYSQL_* directly.
const POOL_SETTINGS = {
  // Keep the pool small so we don't overwhelm the database with connections.
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0,
  connectTimeout: 10_000,
  maxIdle: 2,
  idleTimeout: 60_000,
  enableKeepAlive: true,
};

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo-db:27017';
const MONGO_DB_NAME = process.env.MONGO_DB || 'capacity_lab';

// A dedicated, tiny pool for /readyz's own probe query, so health checks
// never compete with real traffic for one of the main pool's (deliberately
// scarce - connectionLimit: 2) connections. That competition is exactly the
// OPS-2202 failure mode: under pool saturation, a SELECT 1 sharing the main
// pool queues right behind everything else and reports "not ready" for the
// wrong reason (it's not that the DB is down, it's that /readyz is waiting
// in the same line as the traffic it's supposed to be checking).
const PROBE_POOL_SETTINGS = {
  waitForConnections: true,
  connectionLimit: 1,
  queueLimit: 0,
  connectTimeout: 5_000,
};

// ---------------------------------------------------------------------------
// MySQL pools (singletons)
// ---------------------------------------------------------------------------
let pool;
let probePool;

// Resolves DB credentials and creates the pools. Must be awaited once at
// boot (see server.js) before any route calls the synchronous getPool()/
// getProbePool() below - credential resolution can hit the network (Secrets
// Manager/LocalStack), so it can't happen lazily inside a request handler
// without making every getPool() call site async.
async function initPool() {
  if (pool) return pool;
  const creds = await loadDbCredentials();
  const connectionConfig = {
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.dbname,
  };
  pool = mysql.createPool({ ...connectionConfig, ...POOL_SETTINGS });
  probePool = mysql.createPool({ ...connectionConfig, ...PROBE_POOL_SETTINGS });
  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('DB pool not initialized - call initPool() at boot before getPool()');
  }
  return pool;
}

function getProbePool() {
  if (!probePool) {
    throw new Error('DB pool not initialized - call initPool() at boot before getProbePool()');
  }
  return probePool;
}

// Checks the main pool's saturation without running a query (a query would
// itself queue behind the saturation we're trying to detect). Reaches into
// mysql2's internal pool state - `pool.pool` and its `_allConnections` /
// `_freeConnections` / `_connectionQueue` fields aren't public API, so this
// may need updating on a mysql2 major version bump.
function isPoolSaturated() {
  const p = getPool().pool;
  const busy = (p._allConnections?.length ?? 0) - (p._freeConnections?.length ?? 0);
  const queued = p._connectionQueue?.length ?? 0;
  return busy >= POOL_SETTINGS.connectionLimit || queued > 0;
}

// ---------------------------------------------------------------------------
// MongoDB client (singleton, lazily connected)
// ---------------------------------------------------------------------------
let mongoClient;
let mongoDb;

async function getMongo() {
  if (!mongoDb) {
    mongoClient = new MongoClient(MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5_000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
  }
  return mongoDb;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helpers
// ---------------------------------------------------------------------------
async function closeAll() {
  if (pool) {
    try { await pool.end(); } catch (_) { /* ignore */ }
    pool = undefined;
  }
  if (probePool) {
    try { await probePool.end(); } catch (_) { /* ignore */ }
    probePool = undefined;
  }
  if (mongoClient) {
    try { await mongoClient.close(); } catch (_) { /* ignore */ }
    mongoClient = undefined;
    mongoDb = undefined;
  }
}

module.exports = {
  MONGO_URI,
  MONGO_DB_NAME,
  initPool,
  getPool,
  getProbePool,
  isPoolSaturated,
  getMongo,
  closeAll,
};
