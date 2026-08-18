'use strict';

/**
 * secrets.js
 * -----------------------------------------------------------------------------
 * Resolves DB credentials from AWS Secrets Manager, with a fallback to
 * MYSQL_* env vars for local docker-compose runs that don't have a secret
 * provisioned.
 *
 * The client is pointed at process.env.AWS_ENDPOINT_URL when set (LocalStack)
 * and at the default AWS endpoints when it's unset - there is no separate
 * "isLocalStack" branch, the same binary just works against either.
 *
 * The managed DB is Aiven MySQL (external, TLS-required), so the envelope
 * also carries ca_cert - the CA's PEM used to verify the server certificate.
 * Local docker-compose mysql doesn't need TLS, so ca_cert is null when
 * unset - null means "no TLS" all the way through to database.js.
 */

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({
  endpoint: process.env.AWS_ENDPOINT_URL || undefined,
});

// `state.source` is what getSecretSource() hands back. On failure arn/
// versionId are set to null (rather than left populated from a prior
// attempt) so /readyz has a cheap, unambiguous "did this resolve" check.
let state = { status: 'pending', source: { arn: null, versionId: null } };
let credentials;
let inflight;

function credentialsFromEnv() {
  return {
    credentials: {
      host: process.env.MYSQL_HOST || 'mysql-db',
      port: Number(process.env.MYSQL_PORT || 3306),
      username: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'labpassword',
      dbname: process.env.MYSQL_DATABASE || 'capacity_lab',
      ca_cert: process.env.MYSQL_CA_CERT || null,
    },
    source: { arn: 'env', versionId: 'n/a' },
  };
}

async function fetchFromSecretsManager(secretArn) {
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const envelope = JSON.parse(response.SecretString);
  const source = { arn: response.ARN || secretArn, versionId: response.VersionId };

  // Log only the identifiers needed to prove which secret/version got
  // loaded - never the envelope itself, which carries the password (and
  // now the CA cert).
  // eslint-disable-next-line no-console
  console.log(`[secrets] loaded DB credentials from ${source.arn} (version ${source.versionId})`);

  return {
    credentials: {
      host: envelope.host,
      port: Number(envelope.port),
      username: envelope.username,
      password: envelope.password,
      dbname: envelope.dbname,
      ca_cert: envelope.ca_cert,
    },
    source,
  };
}

async function resolveCredentials() {
  const secretArn = process.env.DB_SECRET_ARN;
  try {
    const result = secretArn ? await fetchFromSecretsManager(secretArn) : credentialsFromEnv();
    credentials = result.credentials;
    state = { status: 'ready', source: result.source };
    return credentials;
  } catch (err) {
    state = { status: 'error', source: { arn: null, versionId: null } };
    // eslint-disable-next-line no-console
    console.error(`[secrets] failed to load DB credentials from ${secretArn}: ${err.message}`);
    throw err;
  } finally {
    inflight = undefined;
  }
}

// Resolves and caches DB credentials. Concurrent callers before the first
// resolution share one in-flight fetch rather than each hitting Secrets
// Manager. Call this once at boot (see server.js) so getPool()/readyz can
// stay synchronous afterward.
async function loadDbCredentials() {
  if (state.status === 'ready') return credentials;
  if (!inflight) inflight = resolveCredentials();
  return inflight;
}

// { arn, versionId } of the credentials currently cached - arn/versionId
// are null until the first successful (or failed) load. Never returns the
// credentials themselves.
function getSecretSource() {
  return state.source;
}

module.exports = {
  loadDbCredentials,
  getSecretSource,
};
