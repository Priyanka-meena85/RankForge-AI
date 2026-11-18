const SSL_MODES = new Set(["disable", "require", "verify-full"]);
const DATABASE_URL_SSL_PARAMETERS = new Set([
  "ssl",
  "sslcert",
  "sslkey",
  "sslmode",
  "sslnegotiation",
  "sslpassword",
  "sslrootcert",
  "uselibpqcompat"
]);

function assertDatabaseUrlHasNoSslParameters(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  for (const parameter of url.searchParams.keys()) {
    if (DATABASE_URL_SSL_PARAMETERS.has(parameter.toLowerCase())) {
      throw new Error("Remove PostgreSQL TLS parameters from DATABASE_URL; configure DATABASE_SSL_MODE and DATABASE_SSL_CA instead.");
    }
  }
}

function positiveInteger(value, name, fallback, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function databaseSslMode(env) {
  const mode = env.DATABASE_SSL_MODE
    || (env.DATABASE_SSL === "true" ? "verify-full" : env.DATABASE_SSL === "false" ? "disable" : "disable");
  if (!SSL_MODES.has(mode)) {
    throw new Error("DATABASE_SSL_MODE must be disable, require, or verify-full.");
  }
  return mode;
}

function assertProductionDatabaseTls(env = process.env) {
  if (env.NODE_ENV === "production" && databaseSslMode(env) !== "verify-full") {
    throw new Error("Set DATABASE_SSL_MODE=verify-full in production and configure DATABASE_SSL_CA when the database CA is not system-trusted.");
  }
}

function createPostgresPoolConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  assertDatabaseUrlHasNoSslParameters(env.DATABASE_URL);
  const sslMode = databaseSslMode(env);
  if (env.DATABASE_SSL_CA && sslMode !== "verify-full") {
    throw new Error("DATABASE_SSL_CA requires DATABASE_SSL_MODE=verify-full.");
  }
  const ssl = sslMode === "disable" ? undefined : {
    rejectUnauthorized: sslMode === "verify-full",
    ...(env.DATABASE_SSL_CA ? { ca: env.DATABASE_SSL_CA } : {})
  };
  return {
    connectionString: env.DATABASE_URL,
    application_name: "rankforge-ai",
    max: positiveInteger(env.PG_POOL_MAX, "PG_POOL_MAX", 10, 100),
    idleTimeoutMillis: positiveInteger(env.PG_IDLE_TIMEOUT_MS, "PG_IDLE_TIMEOUT_MS", 30000, 300000),
    connectionTimeoutMillis: positiveInteger(env.PG_CONNECTION_TIMEOUT_MS, "PG_CONNECTION_TIMEOUT_MS", 5000, 120000),
    statement_timeout: positiveInteger(env.PG_STATEMENT_TIMEOUT_MS, "PG_STATEMENT_TIMEOUT_MS", 30000, 300000),
    query_timeout: positiveInteger(env.PG_QUERY_TIMEOUT_MS, "PG_QUERY_TIMEOUT_MS", 35000, 300000),
    idle_in_transaction_session_timeout: positiveInteger(
      env.PG_IDLE_TRANSACTION_TIMEOUT_MS,
      "PG_IDLE_TRANSACTION_TIMEOUT_MS",
      10000,
      300000
    ),
    ssl
  };
}

function resolveTrustProxy(env = process.env) {
  if (env.RENDER === "true") return 1;
  if (!env.TRUST_PROXY) return false;
  const addresses = env.TRUST_PROXY.split(",").map((address) => address.trim()).filter(Boolean);
  if (!addresses.length || addresses.some((address) => /^\d+$/.test(address))) {
    throw new Error("TRUST_PROXY must contain trusted proxy IP addresses or CIDRs, not hop counts.");
  }
  return addresses;
}

module.exports = { assertProductionDatabaseTls, createPostgresPoolConfig, databaseSslMode, resolveTrustProxy };
