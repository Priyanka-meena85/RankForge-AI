const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertProductionDatabaseTls,
  createPostgresPoolConfig,
  databaseSslMode,
  resolveTrustProxy
} = require("../db/postgres");

const baseEnv = { DATABASE_URL: "postgres://rankforge:secret@localhost/rankforge" };

test("PostgreSQL pool defaults are bounded and use certificate verification when TLS is enabled", () => {
  const config = createPostgresPoolConfig({ ...baseEnv, DATABASE_SSL: "true" });
  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.connectionString, baseEnv.DATABASE_URL);
});

test("PostgreSQL TLS verifies the server and accepts an explicitly configured CA", () => {
  const verified = createPostgresPoolConfig({
    ...baseEnv,
    DATABASE_SSL_MODE: "verify-full",
    DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\ntrusted-ca\n-----END CERTIFICATE-----"
  });
  assert.deepEqual(verified.ssl, {
    rejectUnauthorized: true,
    ca: "-----BEGIN CERTIFICATE-----\ntrusted-ca\n-----END CERTIFICATE-----"
  });

  const config = createPostgresPoolConfig({ ...baseEnv, DATABASE_SSL_MODE: "require" });
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  assert.equal(databaseSslMode({ DATABASE_SSL: "true" }), "verify-full");
  assert.throws(() => createPostgresPoolConfig({
    ...baseEnv,
    DATABASE_SSL_MODE: "require",
    DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----"
  }), /requires DATABASE_SSL_MODE=verify-full/);
});

test("PostgreSQL settings reject invalid TLS modes and unsafe pool limits", () => {
  assert.throws(() => databaseSslMode({ DATABASE_SSL_MODE: "prefer" }), /DATABASE_SSL_MODE/);
  assert.throws(() => createPostgresPoolConfig({ ...baseEnv, PG_POOL_MAX: "0" }), /PG_POOL_MAX/);
  assert.throws(() => createPostgresPoolConfig({ ...baseEnv, PG_CONNECTION_TIMEOUT_MS: "-1" }), /PG_CONNECTION_TIMEOUT_MS/);
  assert.throws(() => createPostgresPoolConfig({
    ...baseEnv,
    DATABASE_URL: `${baseEnv.DATABASE_URL}?sslmode=no-verify`,
    DATABASE_SSL_MODE: "verify-full"
  }), /Remove PostgreSQL TLS parameters from DATABASE_URL/);
  assert.throws(() => assertProductionDatabaseTls({ NODE_ENV: "production", DATABASE_SSL_MODE: "require" }), /verify-full/);
  assert.doesNotThrow(() => assertProductionDatabaseTls({ NODE_ENV: "production", DATABASE_SSL_MODE: "verify-full" }));
  assert.doesNotThrow(() => assertProductionDatabaseTls({ NODE_ENV: "development", DATABASE_SSL_MODE: "require" }));
});

test("Render trusts its single ingress proxy while other deployments require proxy addresses", () => {
  assert.equal(resolveTrustProxy({ RENDER: "true" }), 1);
  assert.deepEqual(resolveTrustProxy({ TRUST_PROXY: "10.0.0.0/8,127.0.0.1" }), ["10.0.0.0/8", "127.0.0.1"]);
  assert.equal(resolveTrustProxy({}), false);
  assert.throws(() => resolveTrustProxy({ TRUST_PROXY: "1" }), /not hop counts/);
});
