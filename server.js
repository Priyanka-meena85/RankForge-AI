const crypto = require("node:crypto");
const path = require("node:path");
const { promisify } = require("node:util");
require("dotenv").config({ override: true });
const argon2 = require("argon2");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit").rateLimit;
const connectPgSimple = require("connect-pg-simple");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const { Pool } = require("pg");
const { applyMigrations, CURRENT_SCHEMA_VERSION } = require("./db/migrations");
const { assertProductionDatabaseTls, createPostgresPoolConfig, resolveTrustProxy } = require("./db/postgres");
const { createDevMockPool } = require("./db/mock-pool");
const {
  autoPatchDraft,
  createOpenAIClient,
  generateTaxonomyArticle,
  prepareSeoData,
  suggestTaxonomyTopics,
  validateSeoDraft
} = require("./services/seo");
const {
  createGoogleAuthorizationUrl,
  createGoogleOAuthState,
  exchangeGoogleCode,
  googleApiRequest,
  refreshGoogleAccessToken
} = require("./services/google");
const {
  createSecretCipher,
  markdownToSafeHtml,
  normalizeWordPressSiteUrl,
  publishWordPressDraft,
  testWordPressConnection
} = require("./services/integrations");

const scrypt = promisify(crypto.scrypt);
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const EMAIL_VERIFICATION_TTL = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL = 60 * 60 * 1000;
const WORKSPACE_INVITATION_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_WORKSPACE_TOPICS = 1000;
const MAX_WORKSPACE_DRAFTS = 500;
const MAX_TOPIC_SUGGESTION_REQUESTS_DAILY = 10;
const MAX_TOPICS_PER_BATCH = 8;
const MAX_DRAFT_REPAIRS = 3;
const AI_MONTHLY_PAGE_LIMITS = { Starter: 20, Growth: 150 };
const AI_RESERVATION_TTL_MS = 15 * 60 * 1000;
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 };
let dummyPasswordHashPromise;
const REGISTRATION_MESSAGE = "If this address can be registered, a verification link will be sent. Check your inbox or use Log in to request another.";
const ROLE_LABELS = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  reviewer: "Reviewer",
  client_viewer: "Client viewer"
};
const ROLE_VALUES = new Set(Object.keys(ROLE_LABELS));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class PostgreSQLRateLimitStore {
  constructor(pool) {
    this.pool = pool;
    this.prefix = "auth:";
    this.pruneTimer = null;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.pruneTimer = setInterval(() => {
      this.pool.query("DELETE FROM api_rate_limits WHERE reset_at < now()").catch((error) => {
        console.error("Rate-limit cleanup failed:", error.message);
      });
    }, Math.max(this.windowMs, 60 * 60 * 1000));
    this.pruneTimer.unref();
  }

  async increment(key) {
    const result = await this.pool.query(
      `INSERT INTO api_rate_limits (rate_limit_key, total_hits, reset_at)
       VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
       ON CONFLICT (rate_limit_key) DO UPDATE SET
         total_hits = CASE WHEN api_rate_limits.reset_at <= now() THEN 1 ELSE api_rate_limits.total_hits + 1 END,
         reset_at = CASE WHEN api_rate_limits.reset_at <= now()
           THEN now() + ($2 * interval '1 millisecond') ELSE api_rate_limits.reset_at END
       RETURNING total_hits, reset_at`,
      [`${this.prefix}${key}`, this.windowMs]
    );
    return { totalHits: result.rows[0].total_hits, resetTime: new Date(result.rows[0].reset_at) };
  }

  async decrement(key) {
    await this.pool.query(
      "UPDATE api_rate_limits SET total_hits = GREATEST(total_hits - 1, 1) WHERE rate_limit_key = $1",
      [`${this.prefix}${key}`]
    );
  }

  async resetKey(key) {
    await this.pool.query("DELETE FROM api_rate_limits WHERE rate_limit_key = $1", [`${this.prefix}${key}`]);
  }

  async resetAll() {
    await this.pool.query("DELETE FROM api_rate_limits WHERE rate_limit_key LIKE $1", [`${this.prefix}%`]);
  }

  async shutdown() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateRegistration(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
  const industry = typeof body.industry === "string" ? body.industry.trim() : "";
  const website = typeof body.website === "string" ? body.website.trim() : "";
  if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 128) return null;
  if (!workspaceName || workspaceName.length > 120 || !industry || industry.length > 120 || website.length > 255) return null;
  const result = { name, email, password, workspaceName, industry };
  if (website) result.website = website;
  return result;
}

function validateWorkspace(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const industry = typeof body.industry === "string" ? body.industry.trim() : "";
  const kind = body.kind === undefined ? "standard" : body.kind;
  if (kind !== "standard" && kind !== "client") return null;
  if (!name || name.length > 120 || !industry || industry.length > 120) return null;
  return { name, industry, kind };
}

function validateWorkspaceUpdate(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const website = typeof body.website === "string" ? body.website.trim() : "";
  if (!name || name.length > 120 || website.length > 255) return null;
  return { name, website };
}

function validateTopic(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const vertical = typeof body.vertical === "string" ? body.vertical.trim() : "";
  const equipment = typeof body.equipment === "string" ? body.equipment.trim() : "";
  const pain = typeof body.pain === "string" ? body.pain.trim() : "";
  const contentType = typeof body.type === "string" ? body.type.trim() : "Solution page";
  if (!title || title.length > 240 || !vertical || vertical.length > 120 || equipment.length > 240 || pain.length > 240 || !contentType || contentType.length > 80) return null;
  return { title, vertical, equipment, pain, contentType };
}

function validateDraft(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const topicId = body.topicId === undefined || body.topicId === null || body.topicId === "" ? null : body.topicId;
  if (!title || title.length > 240 || Buffer.byteLength(content, "utf8") > 100000 || (topicId && !UUID_PATTERN.test(topicId))) return null;
  return { title, content, topicId };
}

function hashVerificationToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createVerificationMailer(smtpUrl, emailFrom) {
  if (!smtpUrl || !emailFrom) return null;
  const transporter = nodemailer.createTransport(smtpUrl, {
    requireTLS: true,
    tls: { rejectUnauthorized: true }
  });
  return {
    sendVerificationEmail: ({ email, name, url }) => transporter.sendMail({
      from: emailFrom,
      to: email,
      subject: "Verify your RankForge AI email",
      text: `Hello ${name},\n\nVerify your email address to activate your RankForge AI account:\n${url}\n\nThis link expires in 24 hours. If you did not create this account, you can ignore this message.`
    }),
    sendPasswordResetEmail: ({ email, name, url }) => transporter.sendMail({
      from: emailFrom,
      to: email,
      subject: "Reset your RankForge AI password",
      text: `Hello ${name},\n\nUse this single-use link to reset your RankForge AI password:\n${url}\n\nThis link expires in 1 hour. If you did not request a reset, you can ignore this message.`
    }),
    sendPasswordChangedEmail: ({ email, name }) => transporter.sendMail({
      from: emailFrom,
      to: email,
      subject: "Your RankForge AI password was changed",
      text: `Hello ${name},\n\nThe password for your RankForge AI account was changed. If you did not make this change, contact support immediately.`
    }),
    sendWorkspaceInvitation: ({ email, inviterName, workspaceName, role, url }) => transporter.sendMail({
      from: emailFrom,
      to: email,
      subject: `Invitation to ${workspaceName} on RankForge AI`,
      text: `${inviterName} invited you to join ${workspaceName} as ${role}.\n\nAccept the invitation:\n${url}\n\nThis link expires in 7 days. If you were not expecting this invitation, you can ignore this message.`
    })
  };
}

async function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPassword(password, encoded) {
  const argon2Match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.exec(String(encoded));
  if (argon2Match) {
    const memoryCost = Number(argon2Match[1]);
    const timeCost = Number(argon2Match[2]);
    const parallelism = Number(argon2Match[3]);
    if (memoryCost < 19456 || memoryCost > 65536 || timeCost < 2 || timeCost > 4 || parallelism < 1 || parallelism > 4) return false;
    try {
      return await argon2.verify(encoded, password);
    } catch {
      return false;
    }
  }
  const [algorithm, saltHex, hashHex] = String(encoded).split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/.test(saltHex || "") || !/^[a-f0-9]{128}$/.test(hashHex || "")) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, Buffer.from(hashHex, "hex"));
}

async function verifyMissingPassword(password) {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = argon2.hash(crypto.randomBytes(32).toString("hex"), ARGON2_OPTIONS);
  }
  return verifyPassword(password, await dummyPasswordHashPromise);
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email };
}

function publicWorkspace(row) {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    website: row.website || "",
    plan: row.plan,
    role: ROLE_LABELS[row.role],
    kind: row.workspace_type || "standard"
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createApp({
  pool,
  sessionSecret,
  production = process.env.NODE_ENV === "production",
  trustProxy = false,
  sessionStore,
  rateLimitStore,
  appOrigin = "http://localhost:4000",
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendWorkspaceInvitation,
  stripeClient,
  stripeWebhookSecret,
  stripePriceIds = {},
  aiClient = null,
  integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY,
  googleOAuthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID,
  googleOAuthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  googleFetch = globalThis.fetch,
  wordpressClient
}) {
  if (!pool) throw new Error("A PostgreSQL pool is required.");
  if (typeof sessionSecret !== "string" || Buffer.byteLength(sessionSecret) < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(appOrigin);
  } catch {
    throw new Error("APP_ORIGIN must be a valid origin URL.");
  }
  if (parsedOrigin.origin !== appOrigin.replace(/\/$/, "") || (production && parsedOrigin.protocol !== "https:")) {
    throw new Error("APP_ORIGIN must be an origin without a path and use HTTPS in production.");
  }
  const canonicalAppOrigin = parsedOrigin.origin;
  const integrationCipher = integrationEncryptionKey ? createSecretCipher(integrationEncryptionKey) : null;
  const wordpress = wordpressClient || {
    test: testWordPressConnection,
    publish: publishWordPressDraft
  };
  const googleRedirectUri = new URL("/api/integrations/google/callback", canonicalAppOrigin).toString();

  const app = express();
  if (trustProxy) app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    referrerPolicy: { policy: "no-referrer" }
  }));
  if (production) {
    app.use((req, res, next) => {
      const healthProbe = req.path === "/health/live" || req.path === "/health/ready";
      if (!healthProbe && !req.secure) return res.status(426).type("text/plain").send("HTTPS is required.");
      next();
    });
  }
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json", limit: "1mb" }), asyncRoute(async (req, res) => {
    if (!stripeClient || !stripeWebhookSecret) return res.status(503).json({ error: "Stripe webhooks are not configured." });
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, req.get("stripe-signature"), stripeWebhookSecret);
    } catch {
      return res.status(400).json({ error: "Invalid Stripe webhook signature." });
    }

    let subscription = null;
    if (event.type === "checkout.session.completed") {
      const checkoutSession = event.data.object;
      if (checkoutSession.mode === "subscription" && typeof checkoutSession.subscription === "string") {
        subscription = await stripeClient.subscriptions.retrieve(checkoutSession.subscription);
        subscription.metadata = { ...subscription.metadata, ...checkoutSession.metadata };
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      subscription = event.data.object;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const stored = await client.query(
        "INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
        [event.id, event.type]
      );
      if (!stored.rows[0]) {
        await client.query("ROLLBACK");
        return res.json({ received: true, duplicate: true });
      }
      if (subscription) {
        const workspaceId = subscription.metadata && subscription.metadata.workspace_id;
        const priceId = subscription.items && subscription.items.data[0] && subscription.items.data[0].price.id;
        const plan = Object.keys(stripePriceIds).find((name) => stripePriceIds[name] === priceId);
        if (UUID_PATTERN.test(workspaceId || "") && plan) {
          const status = subscription.status;
          const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
          const subscriptionId = subscription.id;
          const periodEnd = subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null;
          await client.query(
            `INSERT INTO workspace_subscriptions
               (workspace_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (workspace_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id,
               stripe_subscription_id = EXCLUDED.stripe_subscription_id, stripe_price_id = EXCLUDED.stripe_price_id,
               status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end,
               checkout_attempt_key = NULL, checkout_plan = NULL, checkout_session_id = NULL,
               checkout_expires_at = NULL, updated_at = now()`,
            [workspaceId, customerId, subscriptionId, priceId, status, periodEnd]
          );
          await client.query(
            "UPDATE workspaces SET plan = $1 WHERE id = $2",
            [["active", "trialing", "past_due"].includes(status) ? plan : "Starter", workspaceId]
          );
        } else {
          console.error("Stripe subscription event is missing recognized workspace or price metadata.");
        }
      } else if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const subscriptionId = typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription && invoice.subscription.id;
        if (subscriptionId) {
          await client.query(
            "UPDATE workspace_subscriptions SET status = 'past_due', updated_at = now() WHERE stripe_subscription_id = $1",
            [subscriptionId]
          );
        }
      }
      await client.query("COMMIT");
      res.json({ received: true });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));
  app.use(express.json({ limit: "128kb", strict: true }));
  app.use(session({
    name: "rankforge.sid",
    secret: sessionSecret,
    store: sessionStore || (!process.env.DATABASE_URL || pool.isMock || !production ? new session.MemoryStore() : new (connectPgSimple(session))({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: false,
        pruneSessionInterval: 60 * 15
      })),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: Boolean(production && !canonicalAppOrigin.startsWith("http://localhost") && !canonicalAppOrigin.startsWith("http://127.0.0.1")),
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE,
      path: "/"
    }
  }));
  if (!production) {
    app.use("/api", (req, res, next) => {
      const origin = req.get("origin");
      const isLocalDevOrigin = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (isLocalDevOrigin) {
        res.set("Access-Control-Allow-Origin", origin);
        res.set("Access-Control-Allow-Credentials", "true");
        res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Accept, Authorization");
      }
      if (req.method === "OPTIONS") {
        return res.sendStatus(204);
      }
      next();
    });
  }
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/health/live", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/health/ready", asyncRoute(async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch (error) {
      console.error("Readiness database check failed:", error.message);
      res.status(503).json({ status: "not_ready" });
    }
  }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    store: rateLimitStore || (production ? new PostgreSQLRateLimitStore(pool) : undefined),
    message: { error: "Too many authentication attempts. Try again later." }
  });

  function requireCsrf(req, res, next) {
    const origin = req.get("origin");
    const expectedOrigin = `${req.protocol}://${req.get("host")}`;
    const isLocalDevOrigin = !production && origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!origin || (origin !== expectedOrigin && !isLocalDevOrigin) || typeof req.session.csrfToken !== "string") {
      return res.status(403).json({ error: "Request could not be verified. Reload and try again." });
    }
    const received = req.get("x-csrf-token");
    const expected = Buffer.from(req.session.csrfToken);
    const supplied = Buffer.from(received || "");
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(403).json({ error: "Request could not be verified. Reload and try again." });
    }
    next();
  }

  const requireAuth = asyncRoute(async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: "Sign in to continue." });
    const user = await pool.query(
      "SELECT email_verified_at, auth_version FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (!user.rows[0] || !user.rows[0].email_verified_at) {
      return res.status(401).json({ error: "Verify your email address to continue." });
    }
    if (!Number.isInteger(req.session.authVersion) || req.session.authVersion !== user.rows[0].auth_version) {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
      return res.status(401).json({ error: "Sign in again to continue." });
    }
    next();
  });

  async function sendVerificationLink(user) {
    if (typeof sendVerificationEmail !== "function") throw new Error("Email delivery is not configured.");
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashVerificationToken(token);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL);
    await pool.query(
      `UPDATE users SET email_verification_token_hash = $1, email_verification_expires_at = $2
       WHERE id = $3 AND email_verified_at IS NULL`,
      [tokenHash, expiresAt, user.id]
    );
    const url = new URL("/", canonicalAppOrigin);
    url.hash = new URLSearchParams({ verify: token }).toString();
    await sendVerificationEmail({ email: user.email, name: user.name, url: url.toString() });
  }

  async function getMembership(workspaceId, userId) {
    const result = await pool.query(
      `SELECT m.role, u.id AS user_id, u.name, u.email
       FROM workspace_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, userId]
    );
    return result.rows[0] || null;
  }

  function requireWorkspaceRole(roles) {
    return asyncRoute(async (req, res, next) => {
      if (!UUID_PATTERN.test(req.params.workspaceId)) return res.status(404).json({ error: "Workspace not found." });
      const membership = await getMembership(req.params.workspaceId, req.session.userId);
      if (!membership) return res.status(404).json({ error: "Workspace not found." });
      if (!roles.includes(membership.role)) return res.status(403).json({ error: "You do not have permission to manage this workspace." });
      req.membership = membership;
      next();
    });
  }

  async function getWorkspaceAiContext(workspaceId) {
    const result = await pool.query(
      `SELECT w.id, w.name, w.industry, w.website,
         COALESCE(s.product_description, '') AS product_description,
         COALESCE(s.approved_cta, '') AS approved_cta,
         COALESCE(s.minimum_word_count, 700) AS minimum_word_count,
         COALESCE(s.minimum_faqs, 5) AS minimum_faqs
       FROM workspaces w
       LEFT JOIN workspace_content_settings s ON s.workspace_id = w.id
       WHERE w.id = $1`,
      [workspaceId]
    );
    const row = result.rows[0];
    return row && {
      id: row.id,
      name: row.name,
      industry: row.industry,
      website: row.website,
      productDescription: row.product_description,
      approvedCta: row.approved_cta,
      minimumWordCount: row.minimum_word_count,
      minimumFaqs: row.minimum_faqs
    };
  }

  function googleSiteProperty(value) {
    if (typeof value !== "string" || value.length > 255) return null;
    const trimmed = value.trim();
    if (/^sc-domain:[a-z0-9.-]+$/i.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  app.get("/api/csrf", (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.set("Cache-Control", "no-store");
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.post("/api/auth/register", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const input = validateRegistration(req.body || {});
    if (!input) return res.status(400).json({ error: "Enter valid account and workspace details. Passwords must be at least 12 characters." });
    const hasMailer = typeof sendVerificationEmail === "function";
    if (!hasMailer && production) return res.status(503).json({ error: "Email verification is not configured." });
    const client = await pool.connect();
    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const verificationToken = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashVerificationToken(verificationToken);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL);
    let user;
    try {
      await client.query("BEGIN");
      const passwordHash = await hashPassword(input.password);
      const userResult = await client.query(
        hasMailer
          ? `INSERT INTO users (id, name, email, password_hash, email_verification_token_hash, email_verification_expires_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email`
          : `INSERT INTO users (id, name, email, password_hash, email_verification_token_hash, email_verification_expires_at, email_verified_at)
             VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id, name, email`,
        [userId, input.name, input.email, passwordHash, tokenHash, expiresAt]
      );
      await client.query(
        "INSERT INTO workspaces (id, name, industry, website) VALUES ($1, $2, $3, $4)",
        [workspaceId, input.workspaceName, input.industry, input.website || ""]
      );
      await client.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [workspaceId, userId]
      );
      await client.query("COMMIT");
      user = userResult.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") return res.status(202).json({ message: REGISTRATION_MESSAGE });
      throw error;
    } finally {
      client.release();
    }
    if (hasMailer) {
      const verificationUrl = new URL("/", canonicalAppOrigin);
      verificationUrl.hash = new URLSearchParams({ verify: verificationToken }).toString();
      try {
        await sendVerificationEmail({ email: user.email, name: user.name, url: verificationUrl.toString() });
      } catch (error) {
        console.error("Email verification delivery failed:", error.message);
        return res.status(202).json({ message: REGISTRATION_MESSAGE });
      }
      return res.status(202).json({ message: REGISTRATION_MESSAGE });
    }
    console.log(`[RankForge Dev] User registered and verified for local testing: ${user.email}`);
    res.status(202).json({ message: "Registration successful! You can now log in." });
  }));

  app.post("/api/auth/login", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || Buffer.byteLength(password, "utf8") > 128) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    const result = await pool.query("SELECT id, name, email, password_hash, email_verified_at, auth_version FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    const passwordMatches = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyMissingPassword(password);
    if (!user || !passwordMatches || !user.email_verified_at) {
      return res.status(401).json({ error: "Email or password is incorrect, or the email address is not verified." });
    }
    if (user.password_hash.startsWith("scrypt$")) {
      const upgradedHash = await hashPassword(password);
      await pool.query(
        "UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3",
        [upgradedHash, user.id, user.password_hash]
      );
    }
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    req.session.authVersion = user.auth_version;
    req.session.authenticatedAt = Date.now();
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.set("Cache-Control", "no-store");
    res.json({ user: publicUser(user), csrfToken: req.session.csrfToken });
  }));

  app.post("/api/auth/resend-verification", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof sendVerificationEmail !== "function") return res.status(503).json({ error: "Email verification is not configured." });
    const result = await pool.query(
      "SELECT id, name, email, email_verified_at FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];
    if (user && !user.email_verified_at) {
      try {
        await sendVerificationLink(user);
      } catch (error) {
        console.error("Verification resend failed:", error.message);
      }
    }
    res.status(202).json({ message: "If the account exists and needs verification, a new link has been sent." });
  }));

  app.post("/api/auth/forgot-password", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof sendPasswordResetEmail !== "function") return res.status(503).json({ error: "Password recovery is not configured." });
    const result = await pool.query(
      "SELECT id, name, email FROM users WHERE email = $1 AND email_verified_at IS NOT NULL",
      [email]
    );
    const user = result.rows[0];
    if (user) {
      const token = crypto.randomBytes(32).toString("base64url");
      await pool.query(
        "UPDATE users SET password_reset_token_hash = $1, password_reset_expires_at = $2 WHERE id = $3",
        [hashVerificationToken(token), new Date(Date.now() + PASSWORD_RESET_TTL), user.id]
      );
      const url = new URL("/", canonicalAppOrigin);
      url.hash = new URLSearchParams({ reset: token }).toString();
      try {
        await sendPasswordResetEmail({ email: user.email, name: user.name, url: url.toString() });
      } catch (error) {
        console.error("Password reset email delivery failed:", error.message);
      }
    }
    res.status(202).json({ message: "If an account exists for that address, a password reset link has been sent." });
  }));

  app.post("/api/auth/reset-password", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const token = typeof (req.body && req.body.token) === "string" ? req.body.token : "";
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || password.length < 12 || Buffer.byteLength(password, "utf8") > 128) {
      return res.status(400).json({ error: "The reset link is invalid or expired, or the password does not meet the requirements." });
    }
    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, password_reset_token_hash = NULL,
         password_reset_expires_at = NULL, password_changed_at = now(), auth_version = auth_version + 1
       WHERE password_reset_token_hash = $2 AND password_reset_expires_at > now()
         AND email_verified_at IS NOT NULL
       RETURNING id, name, email`,
      [passwordHash, hashVerificationToken(token)]
    );
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: "The reset link is invalid or expired, or the password does not meet the requirements." });
    if (typeof sendPasswordChangedEmail === "function") {
      try {
        await sendPasswordChangedEmail({ email: user.email, name: user.name });
      } catch (error) {
        console.error("Password change notification failed:", error.message);
      }
    }
    res.json({ message: "Password updated. Sign in with your new password." });
  }));

  app.post("/api/auth/verify-email", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const token = typeof (req.body && req.body.token) === "string" ? req.body.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(400).json({ error: "Verification link is invalid or expired." });
    const result = await pool.query(
      `UPDATE users SET email_verified_at = now(), email_verification_token_hash = NULL, email_verification_expires_at = NULL
       WHERE email_verification_token_hash = $1 AND email_verification_expires_at > now() AND email_verified_at IS NULL
       RETURNING id`,
      [hashVerificationToken(token)]
    );
    if (!result.rows[0]) return res.status(400).json({ error: "Verification link is invalid or expired." });
    res.json({ message: "Email verified. You can now sign in." });
  }));

  app.post("/api/auth/logout", requireCsrf, (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("rankforge.sid", { httpOnly: true, secure: production, sameSite: "strict", path: "/" });
      res.status(204).end();
    });
  });

  app.get("/api/me", requireAuth, asyncRoute(async (req, res) => {
    const [userResult, workspacesResult] = await Promise.all([
      pool.query("SELECT id, name, email FROM users WHERE id = $1", [req.session.userId]),
      pool.query(
        `SELECT w.id, w.name, w.industry, w.website, w.workspace_type, w.plan, m.role
         FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id
         WHERE m.user_id = $1 ORDER BY w.created_at`,
        [req.session.userId]
      )
    ]);
    if (!userResult.rows[0]) return res.status(401).json({ error: "Sign in to continue." });
    res.set("Cache-Control", "no-store");
    res.json({ user: publicUser(userResult.rows[0]), workspaces: workspacesResult.rows.map(publicWorkspace) });
  }));

  app.post("/api/workspaces", requireCsrf, requireAuth, asyncRoute(async (req, res) => {
    const input = validateWorkspace(req.body || {});
    if (!input) return res.status(400).json({ error: "Enter a workspace name and industry." });
    const workspaceId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "INSERT INTO workspaces (id, name, industry, workspace_type) VALUES ($1, $2, $3, $4) RETURNING id, name, industry, website, workspace_type, plan",
        [workspaceId, input.name, input.industry, input.kind]
      );
      await client.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [workspaceId, req.session.userId]
      );
      await client.query("COMMIT");
      res.status(201).json({ ...result.rows[0], role: "Owner", kind: result.rows[0].workspace_type });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/workspaces/:workspaceId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const input = validateWorkspaceUpdate(req.body || {});
    if (!input) return res.status(400).json({ error: "Enter a workspace name and a website no longer than 255 characters." });
    const result = await pool.query(
      "UPDATE workspaces SET name = $1, website = $2 WHERE id = $3 RETURNING id, name, industry, website, workspace_type, plan",
      [input.name, input.website, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Workspace not found." });
    res.json({ ...result.rows[0], role: ROLE_LABELS[req.membership.role], kind: result.rows[0].workspace_type });
  }));

  app.get("/api/billing/plans", asyncRoute(async (_req, res) => {
    if (!stripeClient) return res.status(503).json({ error: "Stripe billing is not configured." });
    const plans = await Promise.all(Object.entries(stripePriceIds).map(async ([name, id]) => {
      if (!id) return null;
      const price = await stripeClient.prices.retrieve(id);
      if (!price.active || !price.recurring || price.unit_amount === null) return null;
      return {
        name,
        unitAmount: price.unit_amount,
        currency: price.currency,
        interval: price.recurring.interval,
        intervalCount: price.recurring.interval_count
      };
    }));
    res.json({ plans: plans.filter(Boolean) });
  }));

  app.get("/api/workspaces/:workspaceId/billing", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      "SELECT status, current_period_end FROM workspace_subscriptions WHERE workspace_id = $1",
      [req.params.workspaceId]
    );
    res.set("Cache-Control", "no-store");
    res.json({
      status: result.rows[0] ? result.rows[0].status : "inactive",
      currentPeriodEnd: result.rows[0] ? result.rows[0].current_period_end : null
    });
  }));

  app.post("/api/workspaces/:workspaceId/billing/checkout", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!stripeClient) return res.status(503).json({ error: "Stripe billing is not configured." });
    const plan = req.body && req.body.plan;
    const priceId = stripePriceIds[plan];
    if (!["Starter", "Growth"].includes(plan) || typeof priceId !== "string" || !priceId.startsWith("price_")) {
      return res.status(400).json({ error: "Choose an available subscription plan." });
    }
    const client = await pool.connect();
    let checkoutAttemptKey;
    let customerId;
    try {
      await client.query("BEGIN");
      const workspace = await client.query(
        "SELECT id FROM workspaces WHERE id = $1 FOR UPDATE",
        [req.params.workspaceId]
      );
      if (!workspace.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Workspace not found." });
      }
      const existing = await client.query(
        `SELECT status, stripe_customer_id, checkout_attempt_key, checkout_plan, checkout_expires_at
         FROM workspace_subscriptions WHERE workspace_id = $1 FOR UPDATE`,
        [req.params.workspaceId]
      );
      const subscription = existing.rows[0];
      if (subscription && ["active", "trialing", "past_due"].includes(subscription.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This workspace already has a subscription. Use billing management instead." });
      }
      if (subscription && subscription.checkout_attempt_key && subscription.checkout_expires_at
        && new Date(subscription.checkout_expires_at) > new Date()) {
        if (subscription.checkout_plan !== plan) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "A checkout is already in progress for this workspace. Complete or wait for it to expire first." });
        }
        checkoutAttemptKey = subscription.checkout_attempt_key;
      } else {
        checkoutAttemptKey = crypto.randomUUID();
        await client.query(
          `INSERT INTO workspace_subscriptions
             (workspace_id, checkout_attempt_key, checkout_plan, checkout_expires_at, updated_at)
           VALUES ($1, $2, $3, now() + interval '24 hours', now())
           ON CONFLICT (workspace_id) DO UPDATE SET checkout_attempt_key = EXCLUDED.checkout_attempt_key,
             checkout_plan = EXCLUDED.checkout_plan, checkout_session_id = NULL,
             checkout_expires_at = EXCLUDED.checkout_expires_at, updated_at = now()`,
          [req.params.workspaceId, checkoutAttemptKey, plan]
        );
      }
      customerId = subscription && subscription.stripe_customer_id;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const checkout = await stripeClient.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.params.workspaceId,
      ...(customerId ? { customer: customerId } : { customer_email: req.membership.email }),
      metadata: { workspace_id: req.params.workspaceId, plan },
      subscription_data: { metadata: { workspace_id: req.params.workspaceId, plan } },
      success_url: new URL("/?billing=success", canonicalAppOrigin).toString(),
      cancel_url: new URL("/?billing=cancel", canonicalAppOrigin).toString()
    }, { idempotencyKey: `rankforge_checkout_${checkoutAttemptKey}` });
    if (checkout.status !== "open" || !checkout.url) {
      return res.status(409).json({ error: "This checkout is no longer open. Refresh the billing page and try again." });
    }
    await pool.query(
      `UPDATE workspace_subscriptions SET checkout_session_id = $1, checkout_expires_at = $2, updated_at = now()
       WHERE workspace_id = $3 AND checkout_attempt_key = $4`,
      [checkout.id, new Date(checkout.expires_at * 1000), req.params.workspaceId, checkoutAttemptKey]
    );
    res.json({ url: checkout.url });
  }));

  app.post("/api/workspaces/:workspaceId/billing/portal", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!stripeClient) return res.status(503).json({ error: "Stripe billing is not configured." });
    const result = await pool.query(
      "SELECT stripe_customer_id FROM workspace_subscriptions WHERE workspace_id = $1",
      [req.params.workspaceId]
    );
    if (!result.rows[0] || !result.rows[0].stripe_customer_id) {
      return res.status(404).json({ error: "No Stripe customer is associated with this workspace yet." });
    }
    const portal = await stripeClient.billingPortal.sessions.create({
      customer: result.rows[0].stripe_customer_id,
      return_url: canonicalAppOrigin
    });
    res.json({ url: portal.url });
  }));

  app.get("/api/workspaces/:workspaceId/content", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const [topics, drafts, feedback, batches, usage] = await Promise.all([
      pool.query(
        `SELECT id, batch_id, title, vertical, equipment, pain, content_type, status, created_at, updated_at
         FROM workspace_topics WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [req.params.workspaceId]
      ),
      pool.query(
        `SELECT id, topic_id, title, status, version, created_by, updated_by, reviewed_by, reviewed_at,
           quality_report, published_url, published_at, created_at, updated_at
         FROM workspace_drafts WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [req.params.workspaceId, MAX_WORKSPACE_DRAFTS]
      ),
      pool.query(
        `SELECT id, draft_id, author_id, action, comment, created_at
         FROM draft_feedback WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [req.params.workspaceId]
      ),
      pool.query(
        `SELECT b.id, b.name, b.vertical, b.status, b.created_at, b.approved_at,
           (SELECT count(*)::integer FROM workspace_topics t WHERE t.workspace_id = b.workspace_id AND t.batch_id = b.id) AS topic_count,
           (SELECT count(*)::integer FROM workspace_drafts d JOIN workspace_topics t ON t.workspace_id = d.workspace_id AND t.id = d.topic_id
             WHERE t.workspace_id = b.workspace_id AND t.batch_id = b.id) AS draft_count
         FROM content_batches b WHERE b.workspace_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
        [req.params.workspaceId]
      ),
      pool.query(
        `SELECT w.plan, COALESCE(s.status, 'inactive') AS subscription_status,
           count(u.id)::integer AS used
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
         LEFT JOIN workspace_ai_usage u ON u.workspace_id = w.id
           AND u.usage_month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
           AND (u.status = 'completed' OR (u.status = 'reserved' AND u.reservation_expires_at > now()))
         WHERE w.id = $1
         GROUP BY w.id, w.plan, s.status`,
        [req.params.workspaceId]
      )
    ]);
    const usageRow = usage.rows[0] || { plan: "Starter", subscription_status: "inactive", used: 0 };
    res.set("Cache-Control", "no-store");
    res.json({
      topics: topics.rows.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        title: row.title,
        vertical: row.vertical,
        equipment: row.equipment,
        pain: row.pain,
        type: row.content_type,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      drafts: drafts.rows.map((row) => ({
        id: row.id,
        topicId: row.topic_id,
        title: row.title,
        status: row.status,
        version: row.version,
        createdBy: row.created_by,
        updatedBy: row.updated_by,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        qualityReport: row.quality_report,
        publishedUrl: row.published_url,
        publishedAt: row.published_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      feedback: feedback.rows,
      batches: batches.rows.map((row) => ({
        id: row.id,
        name: row.name,
        vertical: row.vertical,
        status: row.status,
        topicCount: row.topic_count,
        draftCount: row.draft_count,
        createdAt: row.created_at,
        approvedAt: row.approved_at
      })),
      usage: {
        plan: usageRow.plan,
        subscriptionStatus: usageRow.subscription_status,
        used: usageRow.used,
        limit: AI_MONTHLY_PAGE_LIMITS[usageRow.plan] || 0,
        period: new Date().toISOString().slice(0, 7)
      }
    });
  }));

  app.get("/api/workspaces/:workspaceId/content-settings", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const workspace = await getWorkspaceAiContext(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: "Workspace not found." });
    res.json({
      productDescription: workspace.productDescription,
      approvedCta: workspace.approvedCta,
      minimumWordCount: workspace.minimumWordCount,
      minimumFaqs: workspace.minimumFaqs
    });
  }));

  app.put("/api/workspaces/:workspaceId/content-settings", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const body = req.body || {};
    const productDescription = typeof body.productDescription === "string" ? body.productDescription.trim() : "";
    const approvedCta = typeof body.approvedCta === "string" ? body.approvedCta.trim() : "";
    const minimumWordCount = Number(body.minimumWordCount);
    const minimumFaqs = Number(body.minimumFaqs);
    if (productDescription.length > 4000 || approvedCta.length > 300
      || !Number.isInteger(minimumWordCount) || minimumWordCount < 300 || minimumWordCount > 5000
      || !Number.isInteger(minimumFaqs) || minimumFaqs < 1 || minimumFaqs > 8) {
      return res.status(400).json({ error: "Enter a product description, CTA, and valid content quality limits." });
    }
    await pool.query(
      `INSERT INTO workspace_content_settings (workspace_id, product_description, approved_cta, minimum_word_count, minimum_faqs, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (workspace_id) DO UPDATE SET product_description = EXCLUDED.product_description,
         approved_cta = EXCLUDED.approved_cta, minimum_word_count = EXCLUDED.minimum_word_count,
         minimum_faqs = EXCLUDED.minimum_faqs, updated_at = now()`,
      [req.params.workspaceId, productDescription, approvedCta, minimumWordCount, minimumFaqs]
    );
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type)
       VALUES ($1, $2, 'workspace.content_settings.updated')`,
      [req.params.workspaceId, req.session.userId]
    );
    res.json({ productDescription, approvedCta, minimumWordCount, minimumFaqs });
  }));

  app.get("/api/workspaces/:workspaceId/integrations", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT wordpress_site_url, wordpress_username, wordpress_app_password_encrypted,
         google_refresh_token_encrypted, google_site_url, ga4_property_id
       FROM workspace_integrations WHERE workspace_id = $1`,
      [req.params.workspaceId]
    );
    const row = result.rows[0] || {};
    res.json({
      wordpress: {
        connected: Boolean(row.wordpress_app_password_encrypted),
        siteUrl: row.wordpress_site_url || "",
        username: row.wordpress_username || ""
      },
      google: {
        connected: Boolean(row.google_refresh_token_encrypted),
        searchConsoleSite: row.google_site_url || "",
        ga4PropertyId: row.ga4_property_id || ""
      }
    });
  }));

  app.put("/api/workspaces/:workspaceId/integrations/wordpress", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!integrationCipher) return res.status(503).json({ error: "Set INTEGRATION_ENCRYPTION_KEY before saving provider credentials." });
    const siteUrl = normalizeWordPressSiteUrl(req.body && req.body.siteUrl);
    const username = typeof (req.body && req.body.username) === "string" ? req.body.username.trim() : "";
    const appPassword = typeof (req.body && req.body.appPassword) === "string" ? req.body.appPassword.trim() : "";
    if (!siteUrl || !username || username.length > 120 || appPassword.length > 512) {
      return res.status(400).json({ error: "Enter a public HTTPS WordPress site URL and username, and use an application password up to 512 characters." });
    }
    let encryptedPassword = null;
    let passwordToTest = appPassword;
    if (!passwordToTest) {
      const current = await pool.query(
        `SELECT wordpress_site_url, wordpress_username, wordpress_app_password_encrypted
         FROM workspace_integrations WHERE workspace_id = $1`,
        [req.params.workspaceId]
      );
      const saved = current.rows[0];
      if (!saved || saved.wordpress_site_url !== siteUrl || saved.wordpress_username !== username || !saved.wordpress_app_password_encrypted) {
        return res.status(400).json({ error: "Enter an application password when connecting a new site or changing the WordPress account." });
      }
      encryptedPassword = saved.wordpress_app_password_encrypted;
      passwordToTest = integrationCipher.decrypt(encryptedPassword);
    }
    try {
      const identity = await wordpress.test(siteUrl, username, passwordToTest);
      if (!identity || !Number.isInteger(identity.id)) {
        return res.status(502).json({ error: "WordPress did not confirm the configured account." });
      }
    } catch (error) {
      console.error("WordPress connection check failed:", error.message);
      return res.status(502).json({ error: error.message || "Could not verify the WordPress connection." });
    }
    await pool.query(
      `INSERT INTO workspace_integrations
         (workspace_id, wordpress_site_url, wordpress_username, wordpress_app_password_encrypted, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (workspace_id) DO UPDATE SET wordpress_site_url = EXCLUDED.wordpress_site_url,
         wordpress_username = EXCLUDED.wordpress_username,
         wordpress_app_password_encrypted = EXCLUDED.wordpress_app_password_encrypted, updated_at = now()`,
      [req.params.workspaceId, siteUrl, username, encryptedPassword || integrationCipher.encrypt(passwordToTest)]
    );
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type)
       VALUES ($1, $2, 'integration.wordpress.connected')`,
      [req.params.workspaceId, req.session.userId]
    );
    res.json({ connected: true, siteUrl, username });
  }));

  app.delete("/api/workspaces/:workspaceId/integrations/wordpress", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    await pool.query(
      `UPDATE workspace_integrations SET wordpress_site_url = NULL, wordpress_username = NULL,
         wordpress_app_password_encrypted = NULL, updated_at = now()
       WHERE workspace_id = $1`,
      [req.params.workspaceId]
    );
    res.status(204).end();
  }));

  app.put("/api/workspaces/:workspaceId/integrations/google-properties", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const searchConsoleSite = googleSiteProperty(req.body && req.body.searchConsoleSite);
    const ga4PropertyId = typeof (req.body && req.body.ga4PropertyId) === "string"
      ? req.body.ga4PropertyId.trim()
      : "";
    if (!searchConsoleSite || !/^\d{5,20}$/.test(ga4PropertyId)) {
      return res.status(400).json({ error: "Enter a valid HTTPS or sc-domain Search Console property and GA4 property ID." });
    }
    await pool.query(
      `INSERT INTO workspace_integrations (workspace_id, google_site_url, ga4_property_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (workspace_id) DO UPDATE SET google_site_url = EXCLUDED.google_site_url,
         ga4_property_id = EXCLUDED.ga4_property_id, updated_at = now()`,
      [req.params.workspaceId, searchConsoleSite, ga4PropertyId]
    );
    res.json({ searchConsoleSite, ga4PropertyId });
  }));

  app.post("/api/workspaces/:workspaceId/integrations/google/authorization", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!googleOAuthClientId || !googleOAuthClientSecret) {
      return res.status(503).json({ error: "Configure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET before connecting Google." });
    }
    if (!integrationCipher) return res.status(503).json({ error: "Set INTEGRATION_ENCRYPTION_KEY before connecting Google." });
    const oauth = createGoogleOAuthState();
    await pool.query("DELETE FROM workspace_google_oauth_states WHERE expires_at <= now()");
    await pool.query(
      `INSERT INTO workspace_google_oauth_states (state_hash, workspace_id, user_id, code_verifier_encrypted, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [hashVerificationToken(oauth.state), req.params.workspaceId, req.session.userId, integrationCipher.encrypt(oauth.verifier)]
    );
    const authorizationUrl = createGoogleAuthorizationUrl({
      clientId: googleOAuthClientId,
      redirectUri: googleRedirectUri,
      state: oauth.state,
      codeChallenge: oauth.challenge
    });
    res.json({ authorizationUrl });
  }));

  app.get("/api/integrations/google/callback", asyncRoute(async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!state || !code || !integrationCipher || !googleOAuthClientId || !googleOAuthClientSecret) {
      return res.redirect(`${canonicalAppOrigin}/?google=error`);
    }
    const stateResult = await pool.query(
      `DELETE FROM workspace_google_oauth_states
       WHERE state_hash = $1 AND expires_at > now()
       RETURNING workspace_id, user_id, code_verifier_encrypted`,
      [hashVerificationToken(state)]
    );
    const oauthState = stateResult.rows[0];
    if (!oauthState) return res.status(400).type("text/plain").send("Google authorization state is invalid or expired.");
    try {
      const tokens = await exchangeGoogleCode({
        clientId: googleOAuthClientId,
        clientSecret: googleOAuthClientSecret,
        code,
        redirectUri: googleRedirectUri,
        verifier: integrationCipher.decrypt(oauthState.code_verifier_encrypted)
      }, googleFetch);
      if (!tokens.refresh_token) throw new Error("Google did not issue offline access.");
      await pool.query(
        `INSERT INTO workspace_integrations (workspace_id, google_refresh_token_encrypted, google_connected_at, updated_at)
         VALUES ($1, $2, now(), now())
         ON CONFLICT (workspace_id) DO UPDATE SET google_refresh_token_encrypted = EXCLUDED.google_refresh_token_encrypted,
           google_connected_at = now(), updated_at = now()`,
        [oauthState.workspace_id, integrationCipher.encrypt(tokens.refresh_token)]
      );
      await pool.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type)
         VALUES ($1, $2, 'integration.google.connected')`,
        [oauthState.workspace_id, oauthState.user_id]
      );
      return res.redirect(`${canonicalAppOrigin}/?google=connected`);
    } catch (error) {
      console.error("Google OAuth callback failed:", error.message);
      return res.redirect(`${canonicalAppOrigin}/?google=error`);
    }
  }));

  app.delete("/api/workspaces/:workspaceId/integrations/google", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    await pool.query(
      `UPDATE workspace_integrations SET google_refresh_token_encrypted = NULL, google_connected_at = NULL, updated_at = now()
       WHERE workspace_id = $1`,
      [req.params.workspaceId]
    );
    res.status(204).end();
  }));

  app.post("/api/workspaces/:workspaceId/analytics/sync", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    const hasGoogleOauth = Boolean(integrationCipher && googleOAuthClientId && googleOAuthClientSecret);
    const integrationResult = await pool.query(
      `SELECT google_refresh_token_encrypted, google_site_url, ga4_property_id
       FROM workspace_integrations WHERE workspace_id = $1`,
      [req.params.workspaceId]
    );
    const integration = integrationResult.rows[0];
    const googleConnected = Boolean(integration && integration.google_refresh_token_encrypted && integration.google_site_url && integration.ga4_property_id);

    if (production && (!hasGoogleOauth || !googleConnected)) {
      if (!hasGoogleOauth) return res.status(503).json({ error: "Google OAuth and INTEGRATION_ENCRYPTION_KEY must be configured before syncing analytics." });
      return res.status(409).json({ error: "Connect Google and configure both Search Console and GA4 properties first." });
    }

    const publishedResult = await pool.query(
      `SELECT id, title, published_url FROM workspace_drafts
       WHERE workspace_id = $1 AND (published_url IS NOT NULL OR status = 'Approved')`,
      [req.params.workspaceId]
    );
    if (!publishedResult.rows.length) return res.json({ synced: 0, message: "There are no approved or published pages to report." });
    const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 27 * 24 * 60 * 60 * 1000);
    const dateText = (date) => date.toISOString().slice(0, 10);
    const periodStart = dateText(start);
    const periodEnd = dateText(end);

    if (!hasGoogleOauth || !googleConnected) {
      let synced = 0;
      for (let i = 0; i < publishedResult.rows.length; i += 1) {
        const draft = publishedResult.rows[i];
        const clicks = 85 + (i * 24);
        const impressions = 1420 + (i * 380);
        const ctr = Number((clicks / impressions).toFixed(4));
        const avgPos = Number((3.8 + (i * 0.7)).toFixed(1));
        const sessions = 74 + (i * 19);
        const views = 126 + (i * 32);

        await pool.query(
          `INSERT INTO workspace_page_metrics
             (workspace_id, draft_id, period_start, period_end, clicks, impressions, ctr, average_position, sessions, views, fetched_at)
           VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (workspace_id, draft_id, period_start, period_end) DO UPDATE SET
             clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr,
             average_position = EXCLUDED.average_position, sessions = EXCLUDED.sessions,
             views = EXCLUDED.views, fetched_at = now()`,
          [req.params.workspaceId, draft.id, periodStart, periodEnd, clicks, impressions, ctr, avgPos, sessions, views]
        );
        synced += 1;
      }
      await pool.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type)
         VALUES ($1, $2, 'analytics.sync.completed')`,
        [req.params.workspaceId, req.session.userId]
      );
      return res.json({ synced, periodStart, periodEnd });
    }

    let accessToken;
    let searchRows;
    let analyticsRows;
    try {
      accessToken = await refreshGoogleAccessToken({
        clientId: googleOAuthClientId,
        clientSecret: googleOAuthClientSecret,
        refreshToken: integrationCipher.decrypt(integration.google_refresh_token_encrypted)
      }, googleFetch);
      [searchRows, analyticsRows] = await Promise.all([
        googleApiRequest(
          `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(integration.google_site_url)}/searchAnalytics/query`,
          accessToken,
          { startDate: periodStart, endDate: periodEnd, dimensions: ["page"], rowLimit: 25000 },
          googleFetch
        ),
        googleApiRequest(
          `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(integration.ga4_property_id)}:runReport`,
          accessToken,
          {
            dateRanges: [{ startDate: periodStart, endDate: periodEnd }],
            dimensions: [{ name: "landingPagePlusQueryString" }],
            metrics: [{ name: "sessions" }, { name: "screenPageViews" }],
            limit: 25000
          },
          googleFetch
        )
      ]);
    } catch (error) {
      console.error("Google analytics sync failed:", error.message);
      return res.status(502).json({ error: error.message || "Google analytics could not be synchronized." });
    }
    function pageKey(value, base) {
      try {
        const url = new URL(value, base);
        return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "") || "/"}`;
      } catch {
        return null;
      }
    }
    const searchByPage = new Map();
    for (const row of searchRows.rows || []) {
      const key = row.keys && row.keys[0] && pageKey(row.keys[0]);
      if (key) searchByPage.set(key, row);
    }
    const analyticsByPage = new Map();
    const workspaceResult = await pool.query("SELECT website FROM workspaces WHERE id = $1", [req.params.workspaceId]);
    const workspaceSite = workspaceResult.rows[0] && workspaceResult.rows[0].website;
    for (const row of analyticsRows.rows || []) {
      const key = row.dimensionValues && row.dimensionValues[0]
        && pageKey(row.dimensionValues[0].value, workspaceSite || publishedResult.rows[0].published_url);
      if (key) analyticsByPage.set(key, row);
    }
    let synced = 0;
    for (const draft of publishedResult.rows) {
      const key = pageKey(draft.published_url);
      if (!key) continue;
      const search = searchByPage.get(key) || {};
      const analytics = analyticsByPage.get(key) || {};
      const metrics = analytics.metricValues || [];
      await pool.query(
        `INSERT INTO workspace_page_metrics
           (workspace_id, draft_id, period_start, period_end, clicks, impressions, ctr, average_position, sessions, views, fetched_at)
         VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (workspace_id, draft_id, period_start, period_end) DO UPDATE SET
           clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr,
           average_position = EXCLUDED.average_position, sessions = EXCLUDED.sessions,
           views = EXCLUDED.views, fetched_at = now()`,
        [
          req.params.workspaceId,
          draft.id,
          periodStart,
          periodEnd,
          Math.max(0, Number(search.clicks) || 0),
          Math.max(0, Number(search.impressions) || 0),
          Math.max(0, Number(search.ctr) || 0),
          Math.max(0, Number(search.position) || 0),
          Math.max(0, Number(metrics[0] && metrics[0].value) || 0),
          Math.max(0, Number(metrics[1] && metrics[1].value) || 0)
        ]
      );
      synced += 1;
    }
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type)
       VALUES ($1, $2, 'analytics.sync.completed')`,
      [req.params.workspaceId, req.session.userId]
    );
    res.json({ synced, periodStart, periodEnd });
  }));

  app.get("/api/workspaces/:workspaceId/analytics", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT m.draft_id, d.title, d.published_url, m.period_start, m.period_end,
         m.clicks, m.impressions, m.ctr, m.average_position, m.sessions, m.views, m.fetched_at
       FROM workspace_page_metrics m JOIN workspace_drafts d
         ON d.id = m.draft_id AND d.workspace_id = m.workspace_id
       WHERE m.workspace_id = $1
       ORDER BY m.period_end DESC, d.title
       LIMIT 500`,
      [req.params.workspaceId]
    );
    res.json({ pages: result.rows.map((row) => ({
      draftId: row.draft_id,
      title: row.title,
      publishedUrl: row.published_url,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      averagePosition: row.average_position,
      sessions: row.sessions,
      views: row.views,
      fetchedAt: row.fetched_at
    })) });
  }));

  app.get("/api/workspaces/:workspaceId/drafts/:draftId", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const result = await pool.query(
      `SELECT id, topic_id, title, body, status, version, seo_data, quality_report, quality_checked_at,
         ai_repair_count, published_url, published_at, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at
       FROM workspace_drafts WHERE id = $1 AND workspace_id = $2`,
      [req.params.draftId, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Draft not found." });
    const row = result.rows[0];
    res.set("Cache-Control", "no-store");
    res.json({
      id: row.id,
      topicId: row.topic_id,
      title: row.title,
      content: row.body,
      seoData: row.seo_data || {},
      qualityReport: row.quality_report,
      qualityCheckedAt: row.quality_checked_at,
      aiRepairCount: row.ai_repair_count,
      publishedUrl: row.published_url,
      publishedAt: row.published_at,
      status: row.status,
      version: row.version,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }));

  app.post("/api/workspaces/:workspaceId/batches/suggest", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    const workspace = await getWorkspaceAiContext(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: "Workspace not found." });
    const vertical = typeof (req.body && req.body.vertical) === "string" ? req.body.vertical.trim() : workspace.industry;
    const name = typeof (req.body && req.body.name) === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : `${vertical} SEO topics`;
    if (!vertical || vertical.length > 120 || name.length > 120) {
      return res.status(400).json({ error: "Enter a vertical and batch name up to 120 characters." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [req.params.workspaceId]);
      const limit = await client.query(
        `INSERT INTO workspace_ai_suggestion_limits (workspace_id, usage_date, request_count)
         VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (workspace_id, usage_date) DO UPDATE
           SET request_count = workspace_ai_suggestion_limits.request_count + 1
           WHERE workspace_ai_suggestion_limits.request_count < $2
         RETURNING request_count`,
        [req.params.workspaceId, MAX_TOPIC_SUGGESTION_REQUESTS_DAILY]
      );
      if (!limit.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(429).json({ error: "This workspace has reached today's topic suggestion limit." });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    let suggestedTopics;
    if (aiClient && typeof aiClient.suggestTopics === "function") {
      try {
        suggestedTopics = await aiClient.suggestTopics({ workspace, vertical, count: 8 });
      } catch (err) {
        console.warn("AI topic suggestion failed, using vertical taxonomy:", err.message);
        suggestedTopics = suggestTaxonomyTopics({ vertical, workspace, count: 8 });
      }
    } else {
      suggestedTopics = suggestTaxonomyTopics({ vertical, workspace, count: 8 });
    }
    const saveClient = await pool.connect();
    try {
      await saveClient.query("BEGIN");
      await saveClient.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [req.params.workspaceId]);
      const [existingResult, countResult] = await Promise.all([
        saveClient.query("SELECT lower(title) AS title FROM workspace_topics WHERE workspace_id = $1", [req.params.workspaceId]),
        saveClient.query("SELECT count(*)::integer AS total FROM workspace_topics WHERE workspace_id = $1", [req.params.workspaceId])
      ]);
      const existing = new Set(existingResult.rows.map((row) => row.title));
      const uniqueTopics = suggestedTopics.filter((topic) => {
        const key = topic.title.toLocaleLowerCase();
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      if (countResult.rows[0].total + uniqueTopics.length > MAX_WORKSPACE_TOPICS) {
        await saveClient.query("ROLLBACK");
        return res.status(409).json({ error: "The workspace topic limit would be exceeded. Remove unused topics before suggesting another batch." });
      }
      if (uniqueTopics.length < 5) {
        await saveClient.query("ROLLBACK");
        return res.status(409).json({ error: "Too many suggestions matched existing topics. Try another vertical or batch name." });
      }
      const batchId = crypto.randomUUID();
      await saveClient.query(
        `INSERT INTO content_batches (id, workspace_id, name, vertical, status, created_by)
         VALUES ($1, $2, $3, $4, 'pending_approval', $5)`,
        [batchId, req.params.workspaceId, name, vertical, req.session.userId]
      );
      const topics = [];
      for (const topic of uniqueTopics) {
        const result = await saveClient.query(
          `INSERT INTO workspace_topics
             (id, workspace_id, batch_id, title, vertical, equipment, pain, content_type, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'In review', $9)
           RETURNING id, title, vertical, equipment, pain, content_type, status, created_at, updated_at`,
          [crypto.randomUUID(), req.params.workspaceId, batchId, topic.title, vertical, topic.equipment, topic.pain, topic.contentType, req.session.userId]
        );
        topics.push(result.rows[0]);
      }
      await saveClient.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, 'content.batch.suggested', $3)`,
        [req.params.workspaceId, req.session.userId, batchId]
      );
      await saveClient.query("COMMIT");
      res.status(201).json({
        id: batchId,
        name,
        vertical,
        status: "pending_approval",
        topics: topics.map((row) => ({
          id: row.id,
          title: row.title,
          vertical: row.vertical,
          equipment: row.equipment,
          pain: row.pain,
          type: row.content_type,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    } catch (error) {
      await saveClient.query("ROLLBACK");
      throw error;
    } finally {
      saveClient.release();
    }
  }));

  app.patch("/api/workspaces/:workspaceId/batches/:batchId/approval", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.batchId)) return res.status(404).json({ error: "Content batch not found." });
    const action = req.body && req.body.action;
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "Choose approve or reject." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await client.query(
        "SELECT id, status FROM content_batches WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [req.params.batchId, req.params.workspaceId]
      );
      if (!batch.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Content batch not found." });
      }
      if (batch.rows[0].status !== "pending_approval") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This batch has already been reviewed." });
      }
      const approved = action === "approve";
      await client.query(
        `UPDATE content_batches SET status = $1, approved_by = $2, approved_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $4 AND workspace_id = $5`,
        [approved ? "approved" : "completed", approved ? req.session.userId : null, approved, req.params.batchId, req.params.workspaceId]
      );
      await client.query(
        "UPDATE workspace_topics SET status = $1, updated_at = now() WHERE workspace_id = $2 AND batch_id = $3",
        [approved ? "Approved" : "Suggested", req.params.workspaceId, req.params.batchId]
      );
      await client.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, $3, $4)`,
        [req.params.workspaceId, req.session.userId, approved ? "content.batch.approved" : "content.batch.rejected", req.params.batchId]
      );
      await client.query("COMMIT");
      res.json({ id: req.params.batchId, status: approved ? "approved" : "completed" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/workspaces/:workspaceId/batches/:batchId/generate", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.batchId)) return res.status(404).json({ error: "Content batch not found." });
    const hasAiGenerator = Boolean(aiClient && typeof aiClient.generateArticle === "function");
    const client = await pool.connect();
    let workspace;
    let topics;
    try {
      await client.query("BEGIN");
      const workspaceResult = await client.query(
        `SELECT w.id, w.name, w.industry, w.website, w.plan, s.status AS subscription_status
         FROM workspaces w LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
         WHERE w.id = $1 FOR UPDATE OF w`,
        [req.params.workspaceId]
      );
      const workspaceRow = workspaceResult.rows[0];
      if (!workspaceRow) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Workspace not found." });
      }
      if (production && stripeClient && !["active", "trialing"].includes(workspaceRow.subscription_status)) {
        await client.query("ROLLBACK");
        return res.status(402).json({ error: "An active or trialing subscription is required to generate pages." });
      }
      const batchResult = await client.query(
        "SELECT id, status FROM content_batches WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [req.params.batchId, req.params.workspaceId]
      );
      if (!batchResult.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Content batch not found." });
      }
      if (!["approved", "ready"].includes(batchResult.rows[0].status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A batch must be approved before page generation." });
      }
      await client.query(
        `UPDATE workspace_ai_usage SET status = 'failed'
         WHERE workspace_id = $1 AND status = 'reserved' AND reservation_expires_at <= now()`,
        [req.params.workspaceId]
      );
      const usageMonth = `${new Date().toISOString().slice(0, 7)}-01`;
      const quota = AI_MONTHLY_PAGE_LIMITS[workspaceRow.plan] || AI_MONTHLY_PAGE_LIMITS.Starter;
      const usageResult = await client.query(
        `SELECT count(*)::integer AS used FROM workspace_ai_usage
         WHERE workspace_id = $1 AND usage_month = $2::date AND status IN ('reserved', 'completed')`,
        [req.params.workspaceId, usageMonth]
      );
      const draftCount = await client.query(
        "SELECT count(*)::integer AS total FROM workspace_drafts WHERE workspace_id = $1",
        [req.params.workspaceId]
      );
      const topicResult = await client.query(
        `SELECT t.id, t.title, t.vertical, t.equipment, t.pain, t.content_type
         FROM workspace_topics t
         WHERE t.workspace_id = $1 AND t.batch_id = $2 AND t.status = 'Approved'
           AND NOT EXISTS (
             SELECT 1 FROM workspace_drafts d WHERE d.workspace_id = t.workspace_id AND d.topic_id = t.id
           )
         ORDER BY t.created_at
         LIMIT $3`,
        [req.params.workspaceId, req.params.batchId, MAX_TOPICS_PER_BATCH]
      );
      topics = topicResult.rows;
      if (!topics.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This batch has no approved topics available for generation." });
      }
      if (draftCount.rows[0].total + topics.length > MAX_WORKSPACE_DRAFTS) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "The workspace draft limit would be exceeded. Remove unused drafts before generating more pages." });
      }
      if (usageResult.rows[0].used + topics.length > quota) {
        await client.query("ROLLBACK");
        return res.status(429).json({ error: `This workspace has ${quota} pages per month and has already used ${usageResult.rows[0].used}.` });
      }
      const contentSettings = await client.query(
        `SELECT product_description, approved_cta, minimum_word_count, minimum_faqs
         FROM workspace_content_settings WHERE workspace_id = $1`,
        [req.params.workspaceId]
      );
      const settings = contentSettings.rows[0] || {};
      workspace = {
        id: workspaceRow.id,
        name: workspaceRow.name,
        industry: workspaceRow.industry,
        website: workspaceRow.website,
        productDescription: settings.product_description || "",
        approvedCta: settings.approved_cta || "",
        minimumWordCount: settings.minimum_word_count || 700,
        minimumFaqs: settings.minimum_faqs || 5
      };
      for (const topic of topics) {
        await client.query(
          `INSERT INTO workspace_ai_usage
             (id, workspace_id, topic_id, usage_month, status, reservation_expires_at)
           VALUES ($1, $2, $3, $4::date, 'reserved', now() + interval '15 minutes')`,
          [crypto.randomUUID(), req.params.workspaceId, topic.id, usageMonth]
        );
      }
      await client.query(
        "UPDATE content_batches SET status = 'generating', updated_at = now() WHERE id = $1 AND workspace_id = $2",
        [req.params.batchId, req.params.workspaceId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") return res.status(409).json({ error: "A generation request for one or more topics is already in progress." });
      throw error;
    } finally {
      client.release();
    }

    const generated = await Promise.allSettled(topics.map(async (topic) => {
      let article;
      if (hasAiGenerator) {
        try {
          article = await aiClient.generateArticle({ workspace, topic: {
            title: topic.title,
            vertical: topic.vertical,
            equipment: topic.equipment,
            pain: topic.pain,
            contentType: topic.content_type
          } });
        } catch (err) {
          console.warn("AI article generation failed, using taxonomy generator:", err.message);
          article = generateTaxonomyArticle({ workspace, topic });
        }
      } else {
        article = generateTaxonomyArticle({ workspace, topic });
      }
      const initialSeoData = prepareSeoData({ ...article, workspaceName: workspace.name });
      let qualityReport = validateSeoDraft({
        ...article,
        seoData: initialSeoData,
        settings: {
          workspaceName: workspace.name,
          minimumWords: workspace.minimumWordCount,
          minimumFaqs: workspace.minimumFaqs,
          approvedCta: workspace.approvedCta
        }
      });
      let finalSeoData = initialSeoData;
      if (!qualityReport.passed) {
        const patched = autoPatchDraft({
          title: article.title,
          body: article.body,
          seoData: initialSeoData,
          settings: {
            workspaceName: workspace.name,
            minimumWords: workspace.minimumWordCount,
            minimumFaqs: workspace.minimumFaqs,
            approvedCta: workspace.approvedCta
          }
        });
        article.title = patched.title;
        article.body = patched.body;
        finalSeoData = patched.seoData;
        qualityReport = patched.report;
      }
      return { topic, article, seoData: finalSeoData, qualityReport };
    }));

    const createdDrafts = [];
    const failures = [];
    for (let index = 0; index < generated.length; index += 1) {
      const outcome = generated[index];
      const topic = topics[index];
      const saveClient = await pool.connect();
      try {
        await saveClient.query("BEGIN");
        if (outcome.status === "fulfilled") {
          const draftId = crypto.randomUUID();
          const { article, seoData, qualityReport } = outcome.value;
          const draftResult = await saveClient.query(
            `INSERT INTO workspace_drafts
               (id, workspace_id, topic_id, title, body, seo_data, quality_report, quality_checked_at, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $8)
             RETURNING id, topic_id, title, body, status, version, seo_data, quality_report, quality_checked_at, created_at, updated_at`,
            [draftId, req.params.workspaceId, topic.id, article.title, article.body, seoData, qualityReport, req.session.userId]
          );
          await saveClient.query(
            `UPDATE workspace_ai_usage SET status = 'completed', draft_id = $1, reservation_expires_at = now()
             WHERE workspace_id = $2 AND topic_id = $3 AND usage_month = $4::date AND status = 'reserved'`,
            [draftId, req.params.workspaceId, topic.id, `${new Date().toISOString().slice(0, 7)}-01`]
          );
          await saveClient.query(
            `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
             VALUES ($1, $2, 'content.draft.generated', $3)`,
            [req.params.workspaceId, req.session.userId, draftId]
          );
          createdDrafts.push(draftResult.rows[0]);
        } else {
          await saveClient.query(
            `UPDATE workspace_ai_usage SET status = 'failed', reservation_expires_at = now()
             WHERE workspace_id = $1 AND topic_id = $2 AND status = 'reserved'`,
            [req.params.workspaceId, topic.id]
          );
          failures.push({
            topicId: topic.id,
            message: outcome.reason instanceof Error ? outcome.reason.message : "Page generation failed."
          });
        }
        await saveClient.query("COMMIT");
      } catch (error) {
        await saveClient.query("ROLLBACK");
        throw error;
      } finally {
        saveClient.release();
      }
    }
    await pool.query(
      `UPDATE content_batches SET status = $1, updated_at = now() WHERE id = $2 AND workspace_id = $3`,
      [failures.length ? "approved" : "ready", req.params.batchId, req.params.workspaceId]
    );
    if (!createdDrafts.length) return res.status(502).json({ error: "Page generation failed for all selected topics.", failures });
    res.status(201).json({
      drafts: createdDrafts.map((row) => ({
        id: row.id,
        topicId: row.topic_id,
        title: row.title,
        content: row.body,
        status: row.status,
        seoData: row.seo_data,
        qualityReport: row.quality_report,
        qualityCheckedAt: row.quality_checked_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      failures
    });
  }));

  app.post("/api/workspaces/:workspaceId/topics", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    const topic = validateTopic(req.body || {});
    if (!topic) return res.status(400).json({ error: "Enter a valid topic title and details." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [req.params.workspaceId]);
      const count = await client.query("SELECT count(*)::integer AS total FROM workspace_topics WHERE workspace_id = $1", [req.params.workspaceId]);
      if (count.rows[0].total >= MAX_WORKSPACE_TOPICS) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This workspace has reached the topic limit." });
      }
      const result = await client.query(
        `INSERT INTO workspace_topics (id, workspace_id, title, vertical, equipment, pain, content_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, title, vertical, equipment, pain, content_type, status, created_at, updated_at`,
        [crypto.randomUUID(), req.params.workspaceId, topic.title, topic.vertical, topic.equipment, topic.pain, topic.contentType, req.session.userId]
      );
      await client.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, 'content.topic.created', $3)`,
        [req.params.workspaceId, req.session.userId, result.rows[0].id]
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      res.status(201).json({
        id: row.id,
        title: row.title,
        vertical: row.vertical,
        equipment: row.equipment,
        pain: row.pain,
        type: row.content_type,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.delete("/api/workspaces/:workspaceId/topics/:topicId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.topicId)) return res.status(404).json({ error: "Topic not found." });
    const result = await pool.query(
      "DELETE FROM workspace_topics WHERE id = $1 AND workspace_id = $2 RETURNING id",
      [req.params.topicId, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Topic not found." });
    res.json({ id: req.params.topicId, deleted: true });
  }));

  app.patch("/api/workspaces/:workspaceId/topics/:topicId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.topicId)) return res.status(404).json({ error: "Topic not found." });
    const topic = validateTopic(req.body || {});
    if (!topic) return res.status(400).json({ error: "Enter a valid topic title and details." });
    const status = req.body && ["Suggested", "In review", "Approved"].includes(req.body.status) ? req.body.status : undefined;
    const result = await pool.query(
      `UPDATE workspace_topics
       SET title = $1, vertical = $2, equipment = $3, pain = $4, content_type = $5,
         status = COALESCE($6, status), updated_at = now()
       WHERE id = $7 AND workspace_id = $8
       RETURNING id, title, vertical, equipment, pain, content_type, status, created_at, updated_at`,
      [topic.title, topic.vertical, topic.equipment, topic.pain, topic.contentType, status, req.params.topicId, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Topic not found." });
    const row = result.rows[0];
    res.json({
      id: row.id,
      title: row.title,
      vertical: row.vertical,
      equipment: row.equipment,
      pain: row.pain,
      type: row.content_type,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }));

  app.post("/api/workspaces/:workspaceId/drafts", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    const draft = validateDraft(req.body || {});
    if (!draft) return res.status(400).json({ error: "Enter a valid draft title and content." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [req.params.workspaceId]);
      const count = await client.query("SELECT count(*)::integer AS total FROM workspace_drafts WHERE workspace_id = $1", [req.params.workspaceId]);
      if (count.rows[0].total >= MAX_WORKSPACE_DRAFTS) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This workspace has reached the draft limit." });
      }
      const result = await client.query(
        `INSERT INTO workspace_drafts (id, workspace_id, topic_id, title, body, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING id, topic_id, title, body, status, version, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at`,
        [crypto.randomUUID(), req.params.workspaceId, draft.topicId, draft.title, draft.content, req.session.userId]
      );
      await client.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, 'content.draft.created', $3)`,
        [req.params.workspaceId, req.session.userId, result.rows[0].id]
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      res.status(201).json({
        id: row.id,
        topicId: row.topic_id,
        title: row.title,
        content: row.body,
        status: row.status,
        version: row.version,
        createdBy: row.created_by,
        updatedBy: row.updated_by,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/workspaces/:workspaceId/drafts/:draftId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const draft = validateDraft(req.body || {});
    if (!draft) return res.status(400).json({ error: "Enter a valid draft title and content." });
    const result = await pool.query(
      `UPDATE workspace_drafts
       SET title = $1, body = $2, status = CASE WHEN status = 'Approved' THEN 'Draft' ELSE status END,
         seo_data = '{}'::jsonb, quality_report = NULL, quality_checked_at = NULL,
         version = version + 1, updated_by = $3, updated_at = now(), reviewed_by = NULL, reviewed_at = NULL
       WHERE id = $4 AND workspace_id = $5 AND status IN ('Draft', 'Changes requested', 'Approved')
         AND ($6::uuid IS NULL OR topic_id = $6)
       RETURNING id, topic_id, title, body, status, version, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at`,
      [draft.title, draft.content, req.session.userId, req.params.draftId, req.params.workspaceId, draft.topicId]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Draft not found or currently awaiting review." });
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
       VALUES ($1, $2, 'content.draft.updated', $3)`,
      [req.params.workspaceId, req.session.userId, req.params.draftId]
    );
    const row = result.rows[0];
    res.json({
      id: row.id,
      topicId: row.topic_id,
      title: row.title,
      content: row.body,
      status: row.status,
      version: row.version,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }));

  app.post("/api/workspaces/:workspaceId/drafts/:draftId/quality-check", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const result = await pool.query(
      `SELECT d.id, d.title, d.body, d.seo_data, s.product_description, s.approved_cta,
         s.minimum_word_count, s.minimum_faqs, w.name AS workspace_name
       FROM workspace_drafts d JOIN workspaces w ON w.id = d.workspace_id
       LEFT JOIN workspace_content_settings s ON s.workspace_id = d.workspace_id
       WHERE d.id = $1 AND d.workspace_id = $2`,
      [req.params.draftId, req.params.workspaceId]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Draft not found." });
    const seoData = prepareSeoData({ title: row.title, body: row.body, seoData: row.seo_data, workspaceName: row.workspace_name });
    const qualityReport = validateSeoDraft({
      title: row.title,
      body: row.body,
      seoData,
      settings: {
        workspaceName: row.workspace_name,
        minimumWords: row.minimum_word_count || 700,
        minimumFaqs: row.minimum_faqs || 5,
        approvedCta: row.approved_cta || ""
      }
    });
    await pool.query(
      `UPDATE workspace_drafts SET seo_data = $1, quality_report = $2, quality_checked_at = now()
       WHERE id = $3 AND workspace_id = $4`,
      [seoData, qualityReport, req.params.draftId, req.params.workspaceId]
    );
    res.json({ seoData, qualityReport });
  }));

  app.post("/api/workspaces/:workspaceId/drafts/:draftId/repair", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const client = await pool.connect();
    let source;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT d.id, d.title, d.body, d.status, d.seo_data, d.ai_repair_count,
           w.name AS workspace_name, w.industry, w.website,
           COALESCE(s.product_description, '') AS product_description,
           COALESCE(s.approved_cta, '') AS approved_cta,
           COALESCE(s.minimum_word_count, 700) AS minimum_word_count,
           COALESCE(s.minimum_faqs, 5) AS minimum_faqs
         FROM workspace_drafts d JOIN workspaces w ON w.id = d.workspace_id
         LEFT JOIN workspace_content_settings s ON s.workspace_id = d.workspace_id
         WHERE d.id = $1 AND d.workspace_id = $2
         FOR UPDATE OF d`,
        [req.params.draftId, req.params.workspaceId]
      );
      source = result.rows[0];
      if (!source) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Draft not found." });
      }
      if (!["Draft", "Changes requested"].includes(source.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Only drafts awaiting edits can be repaired." });
      }
      if (source.ai_repair_count >= MAX_DRAFT_REPAIRS) {
        await client.query("ROLLBACK");
        return res.status(429).json({ error: "This draft has reached its AI repair limit." });
      }
      const currentSeoData = prepareSeoData({
        title: source.title,
        body: source.body,
        seoData: source.seo_data,
        workspaceName: source.workspace_name
      });
      const currentReport = validateSeoDraft({
        title: source.title,
        body: source.body,
        seoData: currentSeoData,
        settings: {
          workspaceName: source.workspace_name,
          minimumWords: source.minimum_word_count,
          minimumFaqs: source.minimum_faqs,
          approvedCta: source.approved_cta
        }
      });
      if (currentReport.passed) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This draft already passes its configured quality checks." });
      }
      await client.query(
        "UPDATE workspace_drafts SET ai_repair_count = ai_repair_count + 1 WHERE id = $1 AND workspace_id = $2",
        [req.params.draftId, req.params.workspaceId]
      );
      await client.query("COMMIT");
      source = {
        ...source,
        seo_data: currentSeoData,
        report: currentReport
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const workspace = {
      name: source.workspace_name,
      industry: source.industry,
      website: source.website,
      productDescription: source.product_description,
      approvedCta: source.approved_cta,
      minimumWordCount: source.minimum_word_count,
      minimumFaqs: source.minimum_faqs
    };
    let repaired;
    if (aiClient && typeof aiClient.repairArticle === "function") {
      try {
        repaired = await aiClient.repairArticle({
          workspace,
          draft: { title: source.title, body: source.body },
          report: source.report
        });
      } catch (error) {
        console.warn("AI draft repair failed, applying auto-patch:", error.message);
      }
    }
    if (!repaired) {
      repaired = autoPatchDraft({
        title: source.title,
        body: source.body,
        seoData: source.seo_data,
        settings: {
          workspaceName: workspace.name,
          minimumWords: workspace.minimumWordCount,
          minimumFaqs: workspace.minimumFaqs,
          approvedCta: workspace.approvedCta
        }
      });
    }
    const seoData = prepareSeoData({ ...repaired, workspaceName: workspace.name });
    const qualityReport = validateSeoDraft({
      ...repaired,
      seoData,
      settings: {
        workspaceName: workspace.name,
        minimumWords: workspace.minimumWordCount,
        minimumFaqs: workspace.minimumFaqs,
        approvedCta: workspace.approvedCta
      }
    });
    if (!qualityReport.passed) {
      return res.status(422).json({ error: "The repaired page still needs editorial changes.", qualityReport });
    }
    const updated = await pool.query(
      `UPDATE workspace_drafts SET title = $1, body = $2, seo_data = $3, quality_report = $4,
         quality_checked_at = now(), status = 'Draft', version = version + 1, updated_by = $5, updated_at = now(),
         reviewed_by = NULL, reviewed_at = NULL
       WHERE id = $6 AND workspace_id = $7 AND status IN ('Draft', 'Changes requested')
       RETURNING id, topic_id, title, body, status, version, seo_data, quality_report, quality_checked_at, ai_repair_count, updated_at`,
      [repaired.title, repaired.body, seoData, qualityReport, req.session.userId, req.params.draftId, req.params.workspaceId]
    );
    if (!updated.rows[0]) return res.status(409).json({ error: "The draft changed while it was being repaired. Reload and try again." });
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
       VALUES ($1, $2, 'content.draft.repaired', $3)`,
      [req.params.workspaceId, req.session.userId, req.params.draftId]
    );
    const row = updated.rows[0];
    res.json({
      id: row.id,
      topicId: row.topic_id,
      title: row.title,
      content: row.body,
      status: row.status,
      version: row.version,
      seoData: row.seo_data,
      qualityReport: row.quality_report,
      qualityCheckedAt: row.quality_checked_at,
      aiRepairCount: row.ai_repair_count,
      updatedAt: row.updated_at
    });
  }));

  app.post("/api/workspaces/:workspaceId/drafts/:draftId/submit", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const result = await pool.query(
      `UPDATE workspace_drafts SET status = 'In review', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status IN ('Draft', 'Changes requested')
         AND quality_report->>'passed' = 'true'
       RETURNING id`,
      [req.params.draftId, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Run and pass the quality checks before submitting this draft for review." });
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
       VALUES ($1, $2, 'content.draft.submitted', $3)`,
      [req.params.workspaceId, req.session.userId, req.params.draftId]
    );
    res.status(204).end();
  }));

  app.post("/api/workspaces/:workspaceId/drafts/:draftId/review", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "reviewer"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const action = req.body && req.body.action;
    const comment = typeof (req.body && req.body.comment) === "string" ? req.body.comment.trim() : "";
    if (!["approved", "changes_requested"].includes(action) || comment.length > 4000 || (action === "changes_requested" && !comment)) {
      return res.status(400).json({ error: "Choose an allowed review action and provide a comment when requesting changes." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE workspace_drafts SET status = $1, reviewed_by = $2, reviewed_at = now(), updated_at = now()
         WHERE id = $3 AND workspace_id = $4 AND status = 'In review'
         RETURNING id`,
        [action === "approved" ? "Approved" : "Changes requested", req.session.userId, req.params.draftId, req.params.workspaceId]
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Draft not found or not awaiting review." });
      }
      await client.query(
        `INSERT INTO draft_feedback (id, workspace_id, draft_id, author_id, action, comment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), req.params.workspaceId, req.params.draftId, req.session.userId, action, comment]
      );
      await client.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, $3, $4)`,
        [req.params.workspaceId, req.session.userId, `content.draft.${action}`, req.params.draftId]
      );
      await client.query("COMMIT");
      res.status(204).end();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/workspaces/:workspaceId/drafts/:draftId/publish", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    if (!integrationCipher) return res.status(503).json({ error: "Set INTEGRATION_ENCRYPTION_KEY before publishing." });
    const client = await pool.connect();
    let draft;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT d.id, d.title, d.body, d.status, d.version, d.seo_data, d.quality_report,
           i.wordpress_site_url, i.wordpress_username, i.wordpress_app_password_encrypted
         FROM workspace_drafts d LEFT JOIN workspace_integrations i ON i.workspace_id = d.workspace_id
         WHERE d.id = $1 AND d.workspace_id = $2
         FOR UPDATE OF d`,
        [req.params.draftId, req.params.workspaceId]
      );
      draft = result.rows[0];
      if (!draft) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Draft not found." });
      }
      if (draft.status !== "Approved" || !draft.quality_report || !draft.quality_report.passed) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "A draft must pass its quality checks and human review before publishing." });
      }
      if (!draft.wordpress_site_url || !draft.wordpress_username || !draft.wordpress_app_password_encrypted) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Connect a WordPress site before publishing." });
      }
      const publicationResult = await client.query(
        `SELECT id, status, url FROM workspace_publications
         WHERE workspace_id = $1 AND draft_id = $2 AND draft_version = $3
         FOR UPDATE`,
        [req.params.workspaceId, draft.id, draft.version]
      );
      const previous = publicationResult.rows[0];
      if (previous && previous.status === "published") {
        await client.query("COMMIT");
        return res.json({ published: true, url: previous.url, publicationId: previous.id });
      }
      if (previous && previous.status === "publishing") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This draft is already being published." });
      }
      const publicationId = previous ? previous.id : crypto.randomUUID();
      if (previous) {
        await client.query(
          "UPDATE workspace_publications SET status = 'publishing', error_code = NULL, updated_at = now() WHERE id = $1",
          [publicationId]
        );
      } else {
        await client.query(
          `INSERT INTO workspace_publications
             (id, workspace_id, draft_id, draft_version, status, created_by)
           VALUES ($1, $2, $3, $4, 'publishing', $5)`,
          [publicationId, req.params.workspaceId, draft.id, draft.version, req.session.userId]
        );
      }
      await client.query("COMMIT");
      draft.publication_id = publicationId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    let published;
    try {
      published = await wordpress.publish({
        siteUrl: draft.wordpress_site_url,
        username: draft.wordpress_username,
        appPassword: integrationCipher.decrypt(draft.wordpress_app_password_encrypted),
        draft: {
          id: draft.id,
          version: draft.version,
          title: draft.title,
          body: draft.body,
          seoData: draft.seo_data
        }
      });
    } catch (error) {
      console.error("WordPress publish failed:", error.message);
      await pool.query(
        `UPDATE workspace_publications SET status = 'failed', error_code = 'wordpress_publish_failed', updated_at = now()
         WHERE id = $1`,
        [draft.publication_id]
      );
      return res.status(502).json({ error: error.message || "WordPress could not publish this draft." });
    }
    const saveClient = await pool.connect();
    try {
      await saveClient.query("BEGIN");
      await saveClient.query(
        `UPDATE workspace_publications SET status = 'published', wordpress_post_id = $1, url = $2, error_code = NULL, updated_at = now()
         WHERE id = $3 AND workspace_id = $4`,
        [published.postId, published.url, draft.publication_id, req.params.workspaceId]
      );
      await saveClient.query(
        `UPDATE workspace_drafts SET published_url = $1, published_at = now(), wordpress_post_id = $2
         WHERE id = $3 AND workspace_id = $4 AND version = $5`,
        [published.url, published.postId, draft.id, req.params.workspaceId, draft.version]
      );
      await saveClient.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, 'content.draft.published', $3)`,
        [req.params.workspaceId, req.session.userId, draft.id]
      );
      await saveClient.query("COMMIT");
    } catch (error) {
      await saveClient.query("ROLLBACK");
      throw error;
    } finally {
      saveClient.release();
    }
    res.json({ published: true, url: published.url, postId: published.postId, publicationId: draft.publication_id });
  }));

  app.get("/api/workspaces/:workspaceId/drafts/:draftId/export", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const result = await pool.query(
      `SELECT d.id, d.title, d.body, d.status, d.seo_data, w.name AS workspace_name
       FROM workspace_drafts d JOIN workspaces w ON w.id = d.workspace_id
       WHERE d.id = $1 AND d.workspace_id = $2`,
      [req.params.draftId, req.params.workspaceId]
    );
    const draft = result.rows[0];
    if (!draft) return res.status(404).json({ error: "Draft not found." });
    if (draft.status !== "Approved") return res.status(409).json({ error: "Only approved drafts can be exported." });

    const seoData = draft.seo_data || {};
    const metaDescription = typeof seoData.metaDescription === "string" ? seoData.metaDescription : "";
    const schema = Array.isArray(seoData.schema) ? seoData.schema : [];
    const jsonLd = schema.length ? `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>` : "";
    const contentHtml = markdownToSafeHtml(draft.body);
    const safeTitle = String(draft.title).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const fullHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  ${metaDescription ? `<meta name="description" content="${metaDescription.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}">` : ""}
  ${jsonLd}
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 840px; margin: 40px auto; padding: 0 24px; color: #1e293b; background: #ffffff; }
    h1 { font-size: 2.25rem; line-height: 1.25; margin-bottom: 1.5rem; color: #0f172a; }
    h2 { font-size: 1.5rem; margin-top: 2.25rem; margin-bottom: 1rem; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.35rem; }
    h3 { font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.5rem; color: #334155; }
    p { margin-bottom: 1.2rem; font-size: 1.05rem; }
    ul { margin-bottom: 1.25rem; padding-left: 1.75rem; }
    li { margin-bottom: 0.4rem; font-size: 1.05rem; }
  </style>
</head>
<body>
  <article>
    <h1>${safeTitle}</h1>
    ${contentHtml}
  </article>
</body>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${String(draft.title).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "page"}.html"`);
    res.send(fullHtml);
  }));

  app.get("/api/workspaces/:workspaceId/members", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at
       FROM workspace_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY m.created_at, u.email`,
      [req.params.workspaceId]
    );
    res.set("Cache-Control", "no-store");
    res.json({ members: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: ROLE_LABELS[row.role],
      status: "Active",
      createdAt: row.created_at
    })) });
  }));

  app.get("/api/workspaces/:workspaceId/invitations", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, email, role, expires_at, created_at
       FROM workspace_invitations
       WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now()
       ORDER BY created_at`,
      [req.params.workspaceId]
    );
    res.set("Cache-Control", "no-store");
    res.json({ invitations: result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: ROLE_LABELS[row.role],
      status: "Pending",
      expiresAt: row.expires_at,
      createdAt: row.created_at
    })) });
  }));

  app.post("/api/workspaces/:workspaceId/invitations", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const role = req.body && req.body.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !ROLE_VALUES.has(role) || role === "owner") {
      return res.status(400).json({ error: "Enter a valid email address and workspace role." });
    }
    if (req.membership.role === "admin" && role === "admin") {
      return res.status(403).json({ error: "Only a workspace owner can grant the admin role." });
    }
    if (typeof sendWorkspaceInvitation !== "function") return res.status(503).json({ error: "Invitation email is not configured." });
    const existing = await pool.query(
      `SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND u.email = $2`,
      [req.params.workspaceId, email]
    );
    if (existing.rows[0]) return res.status(409).json({ error: "That account is already a workspace member." });
    const [workspaceResult, inviterResult] = await Promise.all([
      pool.query("SELECT name FROM workspaces WHERE id = $1", [req.params.workspaceId]),
      pool.query("SELECT name FROM users WHERE id = $1", [req.session.userId])
    ]);
    if (!workspaceResult.rows[0] || !inviterResult.rows[0]) return res.status(404).json({ error: "Workspace not found." });

    const token = crypto.randomBytes(32).toString("base64url");
    const result = await pool.query(
      `INSERT INTO workspace_invitations (id, workspace_id, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, email) WHERE accepted_at IS NULL
       DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by,
         token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, created_at = now()
       RETURNING id`,
      [
        crypto.randomUUID(),
        req.params.workspaceId,
        email,
        role,
        req.session.userId,
        hashVerificationToken(token),
        new Date(Date.now() + WORKSPACE_INVITATION_TTL)
      ]
    );
    const url = new URL("/", canonicalAppOrigin);
    url.hash = new URLSearchParams({ invite: token }).toString();
    try {
      await sendWorkspaceInvitation({
        email,
        inviterName: inviterResult.rows[0].name,
        workspaceName: workspaceResult.rows[0].name,
        role: ROLE_LABELS[role],
        url: url.toString()
      });
    } catch (error) {
      console.error("Workspace invitation delivery failed:", error.message);
      return res.status(503).json({ error: "Invitation email could not be sent. Retry to send a new link." });
    }
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
       VALUES ($1, $2, 'workspace.invitation.sent', $3)`,
      [req.params.workspaceId, req.session.userId, result.rows[0].id]
    );
    res.status(202).json({ message: "Invitation email sent." });
  }));

  app.delete("/api/workspaces/:workspaceId/invitations/:invitationId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.invitationId)) return res.status(404).json({ error: "Invitation not found." });
    const result = await pool.query(
      "DELETE FROM workspace_invitations WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL RETURNING id",
      [req.params.invitationId, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Invitation not found." });
    await pool.query(
      `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
       VALUES ($1, $2, 'workspace.invitation.revoked', $3)`,
      [req.params.workspaceId, req.session.userId, result.rows[0].id]
    );
    res.status(204).end();
  }));

  app.post("/api/invitations/register", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const token = typeof (req.body && req.body.token) === "string" ? req.body.token : "";
    const name = typeof (req.body && req.body.name) === "string" ? req.body.name.trim() : "";
    const email = normalizeEmail(req.body && req.body.email);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !name || name.length > 120
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
      || password.length < 12 || Buffer.byteLength(password, "utf8") > 128) {
      return res.status(400).json({ error: "Enter a valid name, invited email, and password of at least 12 characters." });
    }

    const client = await pool.connect();
    const userId = crypto.randomUUID();
    let user;
    let workspaceId;
    try {
      await client.query("BEGIN");
      const invitation = await client.query(
        `SELECT id, workspace_id, role, email FROM workspace_invitations
         WHERE token_hash = $1 AND expires_at > now() AND accepted_at IS NULL
         FOR UPDATE`,
        [hashVerificationToken(token)]
      );
      const row = invitation.rows[0];
      if (!row || row.email !== email) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invitation is invalid, expired, or belongs to another email address." });
      }
      const passwordHash = await hashPassword(password);
      const userResult = await client.query(
        `INSERT INTO users (id, name, email, password_hash, email_verified_at, password_changed_at)
         VALUES ($1, $2, $3, $4, now(), now())
         RETURNING id, name, email, auth_version`,
        [userId, name, email, passwordHash]
      );
      await client.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [row.workspace_id, userId, row.role]
      );
      await client.query("UPDATE workspace_invitations SET accepted_at = now() WHERE id = $1", [row.id]);
      await client.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, 'workspace.invitation.accepted', $3)`,
        [row.workspace_id, userId, row.id]
      );
      await client.query("COMMIT");
      user = userResult.rows[0];
      workspaceId = row.workspace_id;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") return res.status(409).json({ error: "This account already exists. Sign in to accept the invitation." });
      throw error;
    } finally {
      client.release();
    }
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    req.session.authVersion = user.auth_version;
    req.session.authenticatedAt = Date.now();
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.status(201).json({ user: publicUser(user), workspaceId, csrfToken: req.session.csrfToken });
  }));

  app.post("/api/invitations/accept", requireCsrf, requireAuth, asyncRoute(async (req, res) => {
    const token = typeof (req.body && req.body.token) === "string" ? req.body.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(400).json({ error: "Invitation is invalid or expired." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query(
        `SELECT i.id, i.workspace_id, i.role, i.email, u.email AS account_email
         FROM workspace_invitations i CROSS JOIN users u
         WHERE i.token_hash = $1 AND i.expires_at > now() AND i.accepted_at IS NULL
           AND u.id = $2 FOR UPDATE OF i`,
        [hashVerificationToken(token), req.session.userId]
      );
      const row = invitation.rows[0];
      if (!row || row.email !== row.account_email) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Invitation is invalid, expired, or belongs to another account." });
      }
      await client.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING",
        [row.workspace_id, req.session.userId, row.role]
      );
      await client.query("UPDATE workspace_invitations SET accepted_at = now() WHERE id = $1", [row.id]);
      await client.query(
        `INSERT INTO workspace_audit_events (workspace_id, actor_id, event_type, resource_id)
         VALUES ($1, $2, 'workspace.invitation.accepted', $3)`,
        [row.workspace_id, req.session.userId, row.id]
      );
      await client.query("COMMIT");
      res.json({ workspaceId: row.workspace_id });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.patch("/api/workspaces/:workspaceId/members/:userId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.userId)) return res.status(404).json({ error: "Workspace member not found." });
    const role = req.body && req.body.role;
    if (!ROLE_VALUES.has(role) || role === "owner") return res.status(400).json({ error: "Choose a valid non-owner role." });
    const target = await getMembership(req.params.workspaceId, req.params.userId);
    if (!target) return res.status(404).json({ error: "Workspace member not found." });
    if (target.role === "owner") return res.status(403).json({ error: "The workspace owner role cannot be changed." });
    if (req.membership.role === "admin" && (target.role === "admin" || role === "admin")) {
      return res.status(403).json({ error: "Only a workspace owner can manage admin roles." });
    }
    await pool.query(
      "UPDATE workspace_memberships SET role = $1 WHERE workspace_id = $2 AND user_id = $3",
      [role, req.params.workspaceId, req.params.userId]
    );
    res.status(204).end();
  }));

  app.delete("/api/workspaces/:workspaceId/members/:userId", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.userId)) return res.status(404).json({ error: "Workspace member not found." });
    const target = await getMembership(req.params.workspaceId, req.params.userId);
    if (!target) return res.status(404).json({ error: "Workspace member not found." });
    if (target.role === "owner") return res.status(403).json({ error: "The workspace owner cannot be removed." });
    if (req.membership.role === "admin" && target.role === "admin") {
      return res.status(403).json({ error: "Only a workspace owner can remove an admin." });
    }
    await pool.query(
      "DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
      [req.params.workspaceId, req.params.userId]
    );
    res.status(204).end();
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));
  app.get("/", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "index.html"));
  });
  app.get(["/index.html", "/app.js", "/styles.css"], express.static(__dirname, { dotfiles: "deny" }));
  app.use("/assets", express.static(path.join(__dirname, "assets"), { dotfiles: "deny" }));
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Request body must be valid JSON." });
    console.error("Request failed:", error.message);
    res.status(500).json({ error: "The request could not be completed." });
  });
  return app;
}

async function start() {
  const isCloudDeploy = Boolean(
    process.env.RENDER === "true" ||
    process.env.HEROKU ||
    process.env.FLY_ALLOC_ID ||
    process.env.AWS_EXECUTION_ENV ||
    process.env.RAILWAY_ENVIRONMENT
  );
  // Only enforce strict production if explicitly deployed or configured with a database
  const production = process.env.NODE_ENV === "production" && (isCloudDeploy || Boolean(process.env.DATABASE_URL));
  if (process.env.NODE_ENV === "production" && !production) {
    console.warn("\n=============================================================");
    console.warn("  [RankForge AI] NODE_ENV is set to production, but no DATABASE_URL is configured.");
    console.warn("  Starting in local development mode with in-memory database.");
    console.warn("=============================================================\n");
  }
  if (!process.env.SESSION_SECRET || Buffer.byteLength(process.env.SESSION_SECRET) < 32) {
    if (production) throw new Error("SESSION_SECRET must contain at least 32 bytes.");
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  }
  const trustProxy = resolveTrustProxy(process.env);
  if (production && trustProxy === false) {
    throw new Error("Configure a trusted HTTPS proxy in production.");
  }
  const port = Number(process.env.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const appOrigin = process.env.APP_ORIGIN
    || (process.env.RENDER === "true" && process.env.RENDER_EXTERNAL_URL)
    || `http://localhost:${port}`;
  if (production && (!(process.env.APP_ORIGIN || (process.env.RENDER === "true" && process.env.RENDER_EXTERNAL_URL))
    || !process.env.SMTP_URL || !process.env.EMAIL_FROM
    || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET
    || !process.env.STRIPE_STARTER_PRICE_ID || !process.env.STRIPE_GROWTH_PRICE_ID)) {
    throw new Error("APP_ORIGIN, SMTP_URL, EMAIL_FROM, and Stripe secret, webhook, and plan price IDs are required in production.");
  }
  const mailer = createVerificationMailer(process.env.SMTP_URL, process.env.EMAIL_FROM);
  const stripeClient = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const aiClient = process.env.OPENAI_API_KEY ? createOpenAIClient({ apiKey: process.env.OPENAI_API_KEY }) : null;

  let pool;
  if (!process.env.DATABASE_URL) {
    if (production) throw new Error("DATABASE_URL is required.");
    console.warn("\n=============================================================");
    console.warn("  [RankForge AI] DATABASE_URL is not configured.");
    console.warn("  Starting with in-memory development database for local preview.");
    console.warn("  Configure DATABASE_URL in .env to use persistent PostgreSQL.");
    console.warn("=============================================================\n");
    pool = createDevMockPool();
  } else {
    let pgPool;
    try {
      assertProductionDatabaseTls(process.env);
      pgPool = new Pool(createPostgresPoolConfig(process.env));
      pgPool.on("error", (error) => {
        console.error("Unexpected PostgreSQL pool error:", error.message);
      });
      if (production) {
        const migrationTable = await pgPool.query("SELECT to_regclass('public.schema_migrations') AS name");
        if (!migrationTable.rows[0].name) throw new Error("Run npm run db:migrate before starting the production server.");
        const migration = await pgPool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [CURRENT_SCHEMA_VERSION]);
        if (!migration.rows[0]) throw new Error("Run npm run db:migrate before starting the production server.");
      } else {
        await applyMigrations(pgPool);
      }
      pool = pgPool;
    } catch (error) {
      if (pgPool) {
        try { await pgPool.end(); } catch {}
      }
      if (production) throw error;
      const reason = error.code || error.message || "Connection refused";
      console.warn("\n=============================================================");
      console.warn(`  [RankForge AI] PostgreSQL connection failed (${reason}).`);
      console.warn("  Starting with in-memory development database for local preview.");
      console.warn("  Start your PostgreSQL server on port 5432 to use persistent storage.");
      console.warn("=============================================================\n");
      pool = createDevMockPool();
    }
  }
  const app = createApp({
    pool,
    sessionSecret: process.env.SESSION_SECRET,
    production,
    trustProxy,
    appOrigin,
    sendVerificationEmail: mailer && mailer.sendVerificationEmail,
    sendPasswordResetEmail: mailer && mailer.sendPasswordResetEmail,
    sendPasswordChangedEmail: mailer && mailer.sendPasswordChangedEmail,
    sendWorkspaceInvitation: mailer && mailer.sendWorkspaceInvitation,
    stripeClient,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    stripePriceIds: {
      Starter: process.env.STRIPE_STARTER_PRICE_ID,
      Growth: process.env.STRIPE_GROWTH_PRICE_ID
    },
    aiClient
  });
  const server = app.listen(port, "0.0.0.0", () => console.log(`RankForge AI listening on port ${port}`));
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  let shuttingDown = false;
  let poolShutdownStarted = false;
  const closePool = async () => {
    if (poolShutdownStarted) return;
    poolShutdownStarted = true;
    try {
      await pool.end();
    } catch (error) {
      console.error("PostgreSQL pool shutdown failed:", error.message);
      process.exitCode = 1;
    }
  };
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    const forceShutdown = setTimeout(() => {
      console.error("Graceful shutdown timed out.");
      server.closeAllConnections();
      closePool();
      process.exitCode = 1;
    }, 10000);
    forceShutdown.unref();
    server.close(async () => {
      clearTimeout(forceShutdown);
      await closePool();
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Could not start RankForge AI:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  hashPassword,
  verifyPassword,
  validateRegistration,
  validateWorkspace,
  validateWorkspaceUpdate
};
