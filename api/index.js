const { createApp } = require("../server");
const { createDevMockPool } = require("../db/mock-pool");
const { Pool } = require("pg");
const { createPostgresPoolConfig, assertProductionDatabaseTls } = require("../db/postgres");

let cachedApp = null;

function getApp() {
  if (cachedApp) return cachedApp;

  let pool;
  if (process.env.DATABASE_URL) {
    try {
      assertProductionDatabaseTls(process.env);
      pool = new Pool(createPostgresPoolConfig(process.env));
      pool.on("error", (err) => console.error("Postgres error:", err.message));
    } catch {
      pool = createDevMockPool();
    }
  } else {
    pool = createDevMockPool();
  }

  const port = process.env.PORT || 4000;
  const appOrigin = process.env.APP_ORIGIN
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${port}`);

  cachedApp = createApp({
    pool,
    sessionSecret: process.env.SESSION_SECRET || "vercel-session-secret-at-least-32-bytes-long-padding",
    production: process.env.NODE_ENV === "production" && Boolean(process.env.DATABASE_URL),
    trustProxy: true,
    appOrigin
  });

  return cachedApp;
}

module.exports = (req, res) => {
  const app = getApp();
  if (req.url && !req.url.startsWith("/api")) {
    req.url = "/api" + (req.url.startsWith("/") ? req.url : "/" + req.url);
  }
  return app(req, res);
};
