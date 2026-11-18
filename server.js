const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
require("dotenv").config();
const argon2 = require("argon2");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit").rateLimit;
const connectPgSimple = require("connect-pg-simple");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const { Pool } = require("pg");

const scrypt = promisify(crypto.scrypt);
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
const EMAIL_VERIFICATION_TTL = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL = 60 * 60 * 1000;
const WORKSPACE_INVITATION_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_WORKSPACE_TOPICS = 1000;
const MAX_WORKSPACE_DRAFTS = 500;
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
const schema = fs.readFileSync(path.join(__dirname, "db", "schema.sql"), "utf8");

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
  if (!name || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  if (password.length < 12 || Buffer.byteLength(password, "utf8") > 128) return null;
  if (!workspaceName || workspaceName.length > 120 || !industry || industry.length > 120) return null;
  return { name, email, password, workspaceName, industry };
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
  appOrigin = "http://localhost:3000",
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendWorkspaceInvitation,
  stripeClient,
  stripeWebhookSecret,
  stripePriceIds = {}
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
      if (!req.secure) return res.status(426).type("text/plain").send("HTTPS is required.");
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
               status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
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
    store: sessionStore || new (connectPgSimple(session))({
        pool,
        tableName: "user_sessions",
        createTableIfMissing: false,
        pruneSessionInterval: 60 * 15
      }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      maxAge: SESSION_MAX_AGE,
      path: "/"
    }
  }));
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
    if (!origin || origin !== expectedOrigin || typeof req.session.csrfToken !== "string") {
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

  app.get("/api/csrf", (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.set("Cache-Control", "no-store");
    res.json({ csrfToken: req.session.csrfToken });
  });

  app.post("/api/auth/register", authLimiter, requireCsrf, asyncRoute(async (req, res) => {
    const input = validateRegistration(req.body || {});
    if (!input) return res.status(400).json({ error: "Enter valid account and workspace details. Passwords must be at least 12 characters." });
    if (typeof sendVerificationEmail !== "function") return res.status(503).json({ error: "Email verification is not configured." });
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
        `INSERT INTO users (id, name, email, password_hash, email_verification_token_hash, email_verification_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email`,
        [userId, input.name, input.email, passwordHash, tokenHash, expiresAt]
      );
      await client.query(
        "INSERT INTO workspaces (id, name, industry) VALUES ($1, $2, $3)",
        [workspaceId, input.workspaceName, input.industry]
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
    const verificationUrl = new URL("/", canonicalAppOrigin);
    verificationUrl.hash = new URLSearchParams({ verify: verificationToken }).toString();
    try {
      await sendVerificationEmail({ email: user.email, name: user.name, url: verificationUrl.toString() });
    } catch (error) {
      console.error("Email verification delivery failed:", error.message);
      return res.status(202).json({ message: REGISTRATION_MESSAGE });
    }
    res.status(202).json({ message: REGISTRATION_MESSAGE });
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
    const existing = await pool.query(
      "SELECT status FROM workspace_subscriptions WHERE workspace_id = $1",
      [req.params.workspaceId]
    );
    if (existing.rows[0] && ["active", "trialing", "past_due"].includes(existing.rows[0].status)) {
      return res.status(409).json({ error: "This workspace already has a subscription. Use billing management instead." });
    }
    const checkout = await stripeClient.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.params.workspaceId,
      customer_email: req.membership.email,
      metadata: { workspace_id: req.params.workspaceId, plan },
      subscription_data: { metadata: { workspace_id: req.params.workspaceId, plan } },
      success_url: new URL("/?billing=success", canonicalAppOrigin).toString(),
      cancel_url: new URL("/?billing=cancel", canonicalAppOrigin).toString()
    });
    if (!checkout.url) return res.status(502).json({ error: "Stripe did not return a checkout URL." });
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
    const [topics, drafts, feedback] = await Promise.all([
      pool.query(
        `SELECT id, title, vertical, equipment, pain, content_type, status, created_at, updated_at
         FROM workspace_topics WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [req.params.workspaceId]
      ),
      pool.query(
        `SELECT id, topic_id, title, status, version, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at
         FROM workspace_drafts WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [req.params.workspaceId, MAX_WORKSPACE_DRAFTS]
      ),
      pool.query(
        `SELECT id, draft_id, author_id, action, comment, created_at
         FROM draft_feedback WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [req.params.workspaceId]
      )
    ]);
    res.set("Cache-Control", "no-store");
    res.json({
      topics: topics.rows.map((row) => ({
        id: row.id,
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
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      feedback: feedback.rows
    });
  }));

  app.get("/api/workspaces/:workspaceId/drafts/:draftId", requireAuth, requireWorkspaceRole(["owner", "admin", "editor", "reviewer", "client_viewer"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const result = await pool.query(
      `SELECT id, topic_id, title, body, status, version, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at
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

  app.post("/api/workspaces/:workspaceId/drafts/:draftId/submit", requireCsrf, requireAuth, requireWorkspaceRole(["owner", "admin", "editor"]), asyncRoute(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.draftId)) return res.status(404).json({ error: "Draft not found." });
    const result = await pool.query(
      `UPDATE workspace_drafts SET status = 'In review', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status IN ('Draft', 'Changes requested')
       RETURNING id`,
      [req.params.draftId, req.params.workspaceId]
    );
    if (!result.rows[0]) return res.status(409).json({ error: "Draft not found or cannot be submitted for review." });
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
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const production = process.env.NODE_ENV === "production";
  if (typeof process.env.SESSION_SECRET !== "string" || Buffer.byteLength(process.env.SESSION_SECRET) < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  if (production && process.env.DATABASE_SSL !== "true") {
    throw new Error("Set DATABASE_SSL=true in production.");
  }
  const trustProxy = process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY.split(",").map((address) => address.trim()).filter(Boolean)
    : false;
  if (production && (!trustProxy || trustProxy.length === 0)) {
    throw new Error("Set TRUST_PROXY to trusted proxy IP addresses in production.");
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const appOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
  if (production && (!process.env.APP_ORIGIN || !process.env.SMTP_URL || !process.env.EMAIL_FROM
    || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET
    || !process.env.STRIPE_STARTER_PRICE_ID || !process.env.STRIPE_GROWTH_PRICE_ID)) {
    throw new Error("APP_ORIGIN, SMTP_URL, EMAIL_FROM, and Stripe secret, webhook, and plan price IDs are required in production.");
  }
  const mailer = createVerificationMailer(process.env.SMTP_URL, process.env.EMAIL_FROM);
  const stripeClient = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });
  if (production) {
    try {
      const migrationTable = await pool.query("SELECT to_regclass('public.schema_migrations') AS name");
      if (!migrationTable.rows[0].name) throw new Error("Run npm run db:migrate before starting the production server.");
      const migration = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", ["001_initial"]);
      if (!migration.rows[0]) throw new Error("Run npm run db:migrate before starting the production server.");
    } catch (error) {
      await pool.end();
      throw error;
    }
  } else {
    try {
      await pool.query(schema);
    } catch (error) {
      await pool.end();
      throw error;
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
    }
  });
  const server = app.listen(port, () => console.log(`RankForge AI listening on port ${port}`));
  const shutdown = () => server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
