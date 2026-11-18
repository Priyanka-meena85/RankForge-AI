# RankForge AI

RankForge AI is an industrial SEO content workspace with a Node.js/Express API and PostgreSQL persistence for accounts, workspaces, topics, batches, drafts, review decisions, quality guardrails, integrations, invitations, and subscription state.

## Run locally

Requirements: Node.js 22 or 24, PostgreSQL, and a TLS-capable SMTP service for account verification, recovery, and invitations.

1. Create a PostgreSQL database and copy `.env.example` to `.env`.
2. Set `DATABASE_URL`, a random `SESSION_SECRET` of at least 32 bytes, `SMTP_URL`, `EMAIL_FROM`, and `APP_ORIGIN` (for local development, `http://localhost:4000`).
3. Install and start:

```powershell
npm ci
npm start
```

In development, the server applies the idempotent schema at startup. Open `APP_ORIGIN`, create an account, and verify the email before signing in. The demo uses sample-only data. Do not serve the frontend with a separate static server; API-backed authentication and CSRF protection require the Express origin.

## Implemented

- Complete 8-step industrial SEO content lifecycle: vertical taxonomy topic suggestions, batch approvals, structured AI page generation (with OpenAI or built-in industrial generator), automated SEO rule validation & auto-patching, human review with QA feedback loops, direct WordPress publishing or clean standalone HTML exports, and Search Console/GA4 traffic & ranking performance dashboards.
- Argon2id password hashing (with legacy scrypt verification and upgrade), email verification, single-use password recovery, change notifications, and session invalidation after password changes.
- PostgreSQL-backed sessions and production authentication rate limits; secure cookie settings, CSRF/origin checks, Helmet headers, a restrictive content security policy, bounded JSON requests, and generic API errors.
- Workspace-scoped membership and content authorization for topics, drafts, review decisions, and feedback. Workspace invitations use hashed, expiring, single-use tokens and are restricted to the invited email.
- Stripe Checkout, customer portal sessions, signed webhook verification, event deduplication, and subscription state synchronization.
- Health and readiness endpoints, production HTTPS enforcement behind the Render ingress or explicitly trusted proxies, configurable database TLS and bounded connection/query timeouts, graceful shutdown, and transaction-locked schema migrations.

See [WORKFLOW.md](./WORKFLOW.md) for user flows, download the [workflow PDF](./WORKFLOW.pdf), and see [`.env.example`](./.env.example) for configuration names.

## Render deployment

The [Dockerfile](./Dockerfile) provides a non-root Node 24 production image. In Render, create a paid web service using this repository's Dockerfile and a PostgreSQL database in the same region. Configure the service:

1. Set the health-check path to `/health/ready` and the pre-deploy command to `npm run db:migrate`.
2. Set `DATABASE_URL` to the database's internal URL and `DATABASE_SSL_MODE=verify-full`. Do not include PostgreSQL TLS parameters in the URL; configure TLS with these environment variables. If the database certificate is signed by a private CA, set `DATABASE_SSL_CA` to that CA's PEM certificate obtained from the provider. Production refuses TLS configurations that do not verify the database certificate and hostname.
3. Set `APP_ORIGIN` to the service's HTTPS URL; for a custom domain, use that domain. Render's ingress is trusted as one hop automatically.
4. Configure `SESSION_SECRET` with a generated secret, plus `SMTP_URL`, `EMAIL_FROM`, Stripe secret/webhook values, and recurring Starter/Growth Price IDs using Render's secret environment-variable fields.
5. Budget PostgreSQL connections across instances: each process defaults to a pool of 10; set `PG_POOL_MAX` lower if scaling or using a small database.

Do not use a free/ephemeral database for customer data. Verify the chosen database plan's backup/PITR retention and run a restore drill before launch.

## Production setup and readiness

For non-Render production, configure `NODE_ENV=production`, `DATABASE_SSL_MODE=verify-full` and, when needed, `DATABASE_SSL_CA` with the database provider's trusted PEM CA certificate, `APP_ORIGIN` as an HTTPS origin, a strong secret-manager-provided `SESSION_SECRET`, SMTP settings, Stripe secret/webhook keys and recurring Starter/Growth Price IDs, and `TRUST_PROXY` with only trusted TLS-terminating proxy IPs/CIDRs. The application rejects production configurations that encrypt database traffic without verifying the server certificate and hostname. Run `npm run db:migrate` before starting the server. Keep the application origin inaccessible except through that proxy, and monitor `/health/live` and `/health/ready`.

This project now has a production container, CI checks backed by PostgreSQL, and a deployment path, but it is **not yet verified production-ready**. Before onboarding customers, validate against the actual PostgreSQL, SMTP, Stripe, and hosting configuration; test database backup restoration and incident recovery; define privacy, retention, support, and data-export/deletion processes; configure centralized monitoring and alerting; and perform an independent deployment security review. Tenant authorization is enforced in API queries and routes, but PostgreSQL row-level security is not configured. Audit events cover selected content and invitation actions, not every administrative operation. Plan entitlement limits, metering, and advanced operational controls also need product-specific validation.

Run `npm run check`, `npm test`, and `npm audit --omit=dev` before release. When `TEST_DATABASE_URL` points to a dedicated database ending in `_test`, `npm test` also runs real PostgreSQL integration tests. CI provisions PostgreSQL and runs this suite. Tests simulate mail, Stripe, and AI/integration providers; they do not substitute for production provider, load, backup/restore, or deployment tests.
