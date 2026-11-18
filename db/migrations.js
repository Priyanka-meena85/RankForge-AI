const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS = [
  {
    version: "001_initial",
    apply: async (client) => {
      const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
      await client.query(schema);
    }
  },
  {
    version: "002_checkout_idempotency",
    apply: async (client) => {
      const migration = fs.readFileSync(
        path.join(__dirname, "migrations", "002_checkout_idempotency.sql"),
        "utf8"
      );
      await client.query(migration);
    }
  },
  {
    version: "003_seo_workflow",
    apply: async (client) => {
      const migration = fs.readFileSync(
        path.join(__dirname, "migrations", "003_seo_workflow.sql"),
        "utf8"
      );
      await client.query(migration);
    }
  }
];

const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
const MIGRATION_LOCK_ID = 736421018;

async function applyMigrations(pool) {
  const client = await pool.connect();
  try {
    for (const migration of MIGRATIONS) {
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
        await client.query(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
             version TEXT PRIMARY KEY,
             applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
           )`
        );
        const applied = await client.query(
          "SELECT 1 FROM schema_migrations WHERE version = $1",
          [migration.version]
        );
        if (applied.rows[0]) {
          await client.query("COMMIT");
          transactionOpen = false;
          continue;
        }
        await migration.apply(client);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { applyMigrations, CURRENT_SCHEMA_VERSION };
