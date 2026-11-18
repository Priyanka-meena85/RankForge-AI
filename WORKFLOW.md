# RankForge AI workflow guide

The authenticated workspace stores topics, drafts, review decisions, invitations, and subscription state in PostgreSQL. **Explore a sample workspace** remains a separate browser-only demo. AI generation, CMS publishing, and analytics are not connected.

## 1. Start the app

Configure PostgreSQL, copy `.env.example` to `.env`, and set the database URL, a unique session secret (at least 32 bytes), SMTP URL/sender, and app origin. Then:

```powershell
npm install
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

## 4. Work with topics and drafts

1. Open **Topics & batches** and add a topic to the workspace.
2. Select topics and use the generation action to create draft records.
3. AI generation is not connected; add or edit draft content manually and save it.
4. Submit a draft for review. Editors can prepare and submit drafts; owners, admins, and reviewers can approve or request changes.
5. Reviewer feedback and review state are stored in PostgreSQL. Changes to approved drafts return them to Draft status.

The API enforces workspace membership, role permissions, request validation, and configured topic/draft storage limits. The sample demo's topics, drafts, patching, and exports are browser-only and should not be used for customer content.

## 5. Billing

Open **Plan & usage** to view configured Starter/Growth recurring Stripe prices and the workspace subscription state. Workspace owners/admins can start Stripe-hosted checkout and open the billing portal. Configure Stripe secret and webhook keys plus recurring price IDs before enabling this in production; webhook signatures are verified and event IDs are deduplicated.

Billing integration does not itself enforce every product entitlement or usage quota. Validate prices, tax, cancellation, failed payments, customer support, and subscription policy before accepting real payments.

## 6. Production deployment checklist

1. Provision PostgreSQL with TLS and network access restricted to the application.
2. Configure `NODE_ENV=production`, `DATABASE_SSL=true`, `APP_ORIGIN` as HTTPS, SMTP, Stripe keys/price IDs, a strong secret-manager session key, and `TRUST_PROXY` with only the exact trusted proxy IPs/CIDRs.
3. Terminate TLS at that proxy and prevent direct public access to the application port.
4. Run `npm run db:migrate`, then start the server. Production startup refuses an unconfigured database, proxy, SMTP, Stripe, or migration.
5. Configure backups and practice restore, monitor readiness, set alerting, and define retention, privacy, access-revocation, and incident-response procedures.
6. Validate with the real PostgreSQL, email, Stripe, and hosting setup. `npm test` uses fakes and does not prove provider or deployment readiness.

The application does not configure PostgreSQL row-level security, comprehensive audit coverage, backup/restore, centralized monitoring, or full entitlement metering. Complete a security/deployment review before using the service with customer data.
