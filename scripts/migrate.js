require("dotenv").config();
const { Pool } = require("pg");
const { applyMigrations } = require("../db/migrations");
const { assertProductionDatabaseTls, createPostgresPoolConfig } = require("../db/postgres");

async function main() {
  assertProductionDatabaseTls(process.env);
  const pool = new Pool(createPostgresPoolConfig());
  try {
    await applyMigrations(pool);
    console.log("Database migrations are up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});
