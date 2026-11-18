# RankForge AI workflow guide

The authenticated workspace stores topics, batches, drafts, review decisions, quality guardrails, integrations, invitations, and subscription state in PostgreSQL. **Explore a sample workspace** remains an offline demo preview.

## 1. Start the app

Use Node.js 22 or 24. Configure PostgreSQL, copy `.env.example` to `.env`, and set the database URL, a unique session secret (at least 32 bytes), SMTP URL/sender, and app origin. Then:

```powershell
npm ci
npm start
```

Development applies the schema at startup. Visit the configured app origin and use **Explore a sample workspace** for demo data, or create an account to use the API-backed workspace.

## 2. Create an account and workspace

1. Select **Create account** and provide your name, email, password (at least 12 characters), workspace name, and industry.
2. Open the verification email and select **Verify email**. The account cannot sign in until verified.
3. Log in using the verified email and password. Sessions are stored in PostgreSQL.
4. If you forget your password, use **Forgot password?** from the login screen and follow the single-use email link. A password reset invalidates existing sessions.

Account creation and password recovery require a functioning SMTP configuration. Messages intentionally use generic responses in cases where revealing whether an email address is registered could expose account information.

## 3. Manage workspaces and team access

- **Settings** updates the workspace name and website on the server.
- **Team & access** lists members and pending invitations. Owners and admins can invite an email as Admin, Editor, Reviewer, or Client viewer; an owner is required to grant or manage the Admin role.
- Invitees can accept through their invitation link by signing in with the invited verified account, or create an account using the same invited email. Links expire after seven days and are single-use.
- Owners and admins can change roles, remove members, and revoke pending invitations. API membership and role checks are applied on every operation.
- **Client workspaces** creates separate workspaces; agency-to-client linking is not modeled.

## 4. Industrial SEO content workflow

The workspace implements an end-to-end 8-step content generation, review, and publishing process:

1. **Client onboarding:**
   - Registration captures company name, target industry vertical, website URL, and credentials.
   - **Settings** manages workspace properties (name, website) and content guardrails (product description, approved CTA, minimum word count, minimum FAQs).
2. **Topic suggestions:**
   - Automatically suggests high-intent industrial topics derived from deep vertical taxonomies (Automotive, Steel, Food & Beverage, HVAC, Chemical, Textile, General Industrial).
   - Powered by OpenAI when `OPENAI_API_KEY` is configured, with built-in taxonomy suggestion fallback when unconfigured or offline. Daily batch suggestion requests are rate-limited to maintain service quality.
3. **Client topic approval and batching:**
   - Clients and team members review suggested topics, approve target topics, or delete unneeded ideas.
   - Approved topics are grouped into structured content batches (up to 8 topics per batch) for bulk generation.
4. **AI page generation:**
   - Generates complete industrial articles containing SEO title, target keyword, meta description, 4+ deep technical sections with specifications, 5+ FAQs, valid Article & FAQPage JSON-LD schemas, and workspace-approved CTAs exceeding 700 words.
   - Powered by OpenAI or the built-in industrial taxonomy generator. Monthly generation quotas are tracked per subscription tier (Starter: 20 pages/month, Growth: 150 pages/month).
5. **Automated validation & auto-patching:**
   - Immediate rule verification checks word count, section count, FAQ count, meta description length (100–160 characters), CTA placement, and JSON-LD schema validity.
   - The auto-patch engine automatically fixes rule violations, expands thin content, injects missing schema scripts, and standardizes descriptions during generation and via the Repair action.
6. **Human review:**
   - Content Review presents an interactive QA strip showing real-time checklist status for each SEO criterion.
   - Reviewers and admins can approve drafts or request changes with feedback notes.
   - Requesting changes feeds reviewer notes back into AI auto-repair for iterative refinement. Changes to approved drafts safely return them to Draft status.
7. **Publish or export:**
   - **Clean HTML export:** Download standalone, semantic HTML files formatted with meta tags, responsive typography, and embedded JSON-LD structured data.
   - **WordPress CMS publishing:** Publish directly to WordPress via authenticated REST API credentials, creating draft or published posts and saving live permalinks and post IDs. Stored credentials are encrypted at rest with AES-256-GCM.
8. **Track results:**
   - **Analytics dashboard:** Track search impressions, clicks, click-through rate (CTR), average SERP ranking position, and page engagement.
   - Connects live Google Search Console and GA4 properties with encrypted OAuth credentials, and provides baseline simulation for local development.

The API enforces workspace membership, role permissions, request validation, and configured storage limits. The sample demo remains available for quick local exploration.

## 5. Billing

Open **Plan & usage** to view configured Starter/Growth recurring Stripe prices and the workspace subscription state. Workspace owners/admins can start Stripe-hosted checkout and open the billing portal. Configure Stripe secret and webhook keys plus recurring price IDs before enabling this in production; webhook signatures are verified and event IDs are deduplicated.

Billing integration does not itself enforce every product entitlement or usage quota. Validate prices, tax, cancellation, failed payments, customer support, and subscription policy before accepting real payments.

## 6. Production deployment checklist

### Render

1. Create a paid Render web service from the repository's [Dockerfile](./Dockerfile) and a PostgreSQL database in the same region.
2. Set `/health/ready` as the HTTP health-check path and `npm run db:migrate` as the pre-deploy command.
3. Use the database internal URL with `DATABASE_SSL_MODE=verify-full`. If the database certificate uses a private CA, set `DATABASE_SSL_CA` to the provider's trusted PEM certificate. Do not put PostgreSQL TLS options such as `sslmode` in `DATABASE_URL`; configure TLS with the environment variables instead. Render is detected automatically for proxy trust; the application accepts its HTTPS-terminated ingress and rejects direct HTTP for application routes.
4. Set `APP_ORIGIN` to the canonical HTTPS origin (custom domain if configured), `SESSION_SECRET` to a generated secret, and configure SMTP and Stripe secrets/price IDs in Render's secret environment-variable settings.
5. Set `PG_POOL_MAX` to fit the database connection budget across the maximum number of service instances. Keep direct database access private.

### Other hosts

1. Provision PostgreSQL with TLS and network access restricted to the application.
2. Configure `NODE_ENV=production`, `DATABASE_SSL_MODE=verify-full`, and `DATABASE_SSL_CA` when the database CA is not system-trusted. Do not put PostgreSQL TLS options in `DATABASE_URL`. Also configure `APP_ORIGIN` as HTTPS, SMTP, Stripe keys/price IDs, and a secret-manager-provided session key.
3. Set `TRUST_PROXY` to the exact trusted proxy IPs/CIDRs. Do not expose the application port publicly; terminate TLS at that proxy.
4. Run `npm run db:migrate`, then start the container or `npm start`. Production startup refuses an unconfigured database, proxy, SMTP, Stripe, or migration.

### Release checks

1. Run `npm run check`, `npm test`, and `npm audit --omit=dev`. CI runs the same checks against a temporary PostgreSQL 16 service.
2. For local real-database checks, set `TEST_DATABASE_URL` only to a disposable database whose name ends with `_test`; the integration test creates and removes test records.
3. Configure backups/PITR, complete a restore drill, monitor readiness, set alerting, and define retention, privacy, access revocation, and incident response.
4. Validate the real SMTP, Stripe webhook, checkout/portal, hosting, and custom-domain flows. Automated tests use simulated mail and Stripe providers.

The application does not configure PostgreSQL row-level security, comprehensive audit coverage, backup/restore, centralized monitoring, customer data export/deletion, or full entitlement metering. Complete legal/privacy review and an independent security/deployment review before using the service with customer data.
