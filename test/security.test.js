const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const session = require("express-session");
const Stripe = require("stripe");
const { promisify } = require("node:util");
const {
  createApp,
  hashPassword,
  verifyPassword,
  validateRegistration,
  validateWorkspace,
  validateWorkspaceUpdate
} = require("../server");

function createFakePool() {
  const users = [];
  const workspaces = [];
  const memberships = [];
  const topics = [];
  const drafts = [];
  const feedback = [];
  const invitations = [];
  const stripeEvents = [];
  const subscriptions = [];

  async function query(sql, values = []) {
    const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (statement === "select 1") return { rows: [{ "?column?": 1 }] };
    if (statement.startsWith("insert into users")) {
      if (users.some((user) => user.email === values[2])) {
        const error = new Error("duplicate user");
        error.code = "23505";
        throw error;
      }
      const user = {
        id: values[0],
        name: values[1],
        email: values[2],
        password_hash: values[3],
        email_verification_token_hash: values[4],
        email_verification_expires_at: values[5],
        email_verified_at: statement.includes("email_verified_at") ? new Date() : null,
        password_reset_token_hash: null,
        password_reset_expires_at: null,
        password_changed_at: new Date(Date.now() - 10000),
        auth_version: 0
      };
      users.push(user);
      return { rows: [{ id: user.id, name: user.name, email: user.email, auth_version: user.auth_version }] };
    }
    if (statement.startsWith("insert into workspaces")) {
      const cols = statement.slice(0, statement.indexOf("values"));
      const hasWebsite = cols.includes("website");
      const hasType = cols.includes("workspace_type");
      const workspace = {
        id: values[0],
        name: values[1],
        industry: values[2],
        website: hasWebsite ? (values[3] || "") : "",
        workspace_type: hasType ? (hasWebsite ? values[4] : values[3]) : "standard",
        plan: "Starter"
      };
      workspaces.push(workspace);
      return { rows: statement.includes("returning") ? [workspace] : [] };
    }
    if (statement.startsWith("insert into workspace_memberships")) {
      if (!statement.includes("on conflict") && memberships.some((membership) => membership.workspace_id === values[0] && membership.user_id === values[1])) {
        const error = new Error("duplicate membership");
        error.code = "23505";
        throw error;
      }
      memberships.push({
        workspace_id: values[0],
        user_id: values[1],
        role: values[2] || (statement.includes("'owner'") ? "owner" : null),
        created_at: new Date()
      });
      return { rows: [] };
    }
    if (statement.startsWith("select id, name, email, password_hash, email_verified_at, auth_version from users where email")) {
      return { rows: users.filter((user) => user.email === values[0]) };
    }
    if (statement.startsWith("select id, name, email, email_verified_at from users where email")) {
      return { rows: users.filter((user) => user.email === values[0]) };
    }
    if (statement.startsWith("select id, name, email from users where email = $1 and email_verified_at is not null")) {
      return { rows: users.filter((user) => user.email === values[0] && user.email_verified_at).map(({ id, name, email }) => ({ id, name, email })) };
    }
    if (statement.startsWith("select 1 from workspace_memberships m join users u")) {
      return { rows: memberships.some((membership) => {
        const user = users.find((item) => item.id === membership.user_id);
        return membership.workspace_id === values[0] && user && user.email === values[1];
      }) ? [{ "?column?": 1 }] : [] };
    }
    if (statement.startsWith("select name from workspaces where id")) {
      return { rows: workspaces.filter((workspace) => workspace.id === values[0]).map(({ name }) => ({ name })) };
    }
    if (statement.startsWith("select id from workspaces where id = $1 for update")) {
      return { rows: workspaces.filter((workspace) => workspace.id === values[0]).map(({ id }) => ({ id })) };
    }
    if (statement.startsWith("select name from users where id")) {
      return { rows: users.filter((user) => user.id === values[0]).map(({ name }) => ({ name })) };
    }
    if (statement.startsWith("select id, name, email from users where id")) {
      return { rows: users.filter((user) => user.id === values[0]).map(({ id, name, email }) => ({ id, name, email })) };
    }
    if (statement.startsWith("select email_verified_at, auth_version from users where id")) {
      return { rows: users.filter((user) => user.id === values[0]).map(({ email_verified_at, auth_version }) => ({ email_verified_at, auth_version })) };
    }
    if (statement.startsWith("update users set password_reset_token_hash")) {
      const user = users.find((item) => item.id === values[2]);
      if (user) {
        user.password_reset_token_hash = values[0];
        user.password_reset_expires_at = values[1];
      }
      return { rows: [] };
    }
    if (statement.startsWith("update users set password_hash = $1")) {
      const user = users.find((item) =>
        item.password_reset_token_hash === values[1]
        && item.password_reset_expires_at > new Date()
        && item.email_verified_at
      );
      if (!user) return { rows: [] };
      user.password_hash = values[0];
      user.password_reset_token_hash = null;
      user.password_reset_expires_at = null;
      user.password_changed_at = new Date();
      user.auth_version += 1;
      return { rows: [{ id: user.id, name: user.name, email: user.email }] };
    }
    if (statement.startsWith("select w.id, w.name, w.industry")) {
      const rows = memberships.filter((membership) => membership.user_id === values[0]).map((membership) => {
        const workspace = workspaces.find((item) => item.id === membership.workspace_id);
        return { ...workspace, role: membership.role };
      });
      return { rows };
    }
    if (statement.startsWith("select m.role, u.id as user_id")) {
      const membership = memberships.find((item) => item.workspace_id === values[0] && item.user_id === values[1]);
      const user = users.find((item) => item.id === values[1]);
      return { rows: membership && user ? [{ role: membership.role, user_id: user.id, name: user.name, email: user.email }] : [] };
    }
    if (statement.startsWith("select u.id, u.name, u.email, m.role, m.created_at")) {
      const rows = memberships.filter((membership) => membership.workspace_id === values[0]).map((membership) => {
        const user = users.find((item) => item.id === membership.user_id);
        return { id: user.id, name: user.name, email: user.email, role: membership.role, created_at: membership.created_at };
      });
      return { rows };
    }
    if (statement.startsWith("select id, email, role, expires_at, created_at from workspace_invitations")) {
      return { rows: invitations.filter((invitation) => invitation.workspace_id === values[0] && !invitation.accepted_at && invitation.expires_at > new Date()) };
    }
    if (statement.startsWith("insert into workspace_invitations")) {
      let invitation = invitations.find((item) => item.workspace_id === values[1] && item.email === values[2] && !item.accepted_at);
      if (invitation) {
        invitation.role = values[3];
        invitation.invited_by = values[4];
        invitation.token_hash = values[5];
        invitation.expires_at = values[6];
        invitation.created_at = new Date();
      } else {
        invitation = {
          id: values[0],
          workspace_id: values[1],
          email: values[2],
          role: values[3],
          invited_by: values[4],
          token_hash: values[5],
          expires_at: values[6],
          accepted_at: null,
          created_at: new Date()
        };
        invitations.push(invitation);
      }
      return { rows: [{ id: invitation.id }] };
    }
    if (statement.startsWith("select id, workspace_id, role, email from workspace_invitations")) {
      const invitation = invitations.find((item) => item.token_hash === values[0] && item.expires_at > new Date() && !item.accepted_at);
      return { rows: invitation ? [{ id: invitation.id, workspace_id: invitation.workspace_id, role: invitation.role, email: invitation.email }] : [] };
    }
    if (statement.startsWith("select i.id, i.workspace_id, i.role, i.email, u.email as account_email")) {
      const invitation = invitations.find((item) => item.token_hash === values[0] && item.expires_at > new Date() && !item.accepted_at);
      const user = users.find((item) => item.id === values[1]);
      return { rows: invitation && user ? [{ id: invitation.id, workspace_id: invitation.workspace_id, role: invitation.role, email: invitation.email, account_email: user.email }] : [] };
    }
    if (statement.startsWith("update workspace_invitations set accepted_at")) {
      const invitation = invitations.find((item) => item.id === values[0]);
      if (invitation) invitation.accepted_at = new Date();
      return { rows: [] };
    }
    if (statement.startsWith("delete from workspace_invitations")) {
      const index = invitations.findIndex((item) => item.id === values[0] && item.workspace_id === values[1] && !item.accepted_at);
      const [removed] = index >= 0 ? invitations.splice(index, 1) : [];
      return { rows: removed ? [{ id: removed.id }] : [] };
    }
    if (statement.startsWith("select id from workspaces where id")) {
      return { rows: workspaces.filter((workspace) => workspace.id === values[0]).map(({ id }) => ({ id })) };
    }
    if (statement.startsWith("delete from workspace_topics")) {
      const index = topics.findIndex((item) => item.id === values[0] && item.workspace_id === values[1]);
      const [removed] = index >= 0 ? topics.splice(index, 1) : [];
      return { rows: removed ? [{ id: removed.id }] : [] };
    }
    if (statement.includes("from workspace_drafts d join workspaces w on w.id = d.workspace_id")) {
      const draft = drafts.find((d) => d.id === values[0] && d.workspace_id === values[1]);
      const workspace = workspaces.find((w) => w.id === values[1]);
      return { rows: draft && workspace ? [{ ...draft, workspace_name: workspace.name }] : [] };
    }
    if (statement.startsWith("select count(*)::integer as total from workspace_topics")) {
      return { rows: [{ total: topics.filter((topic) => topic.workspace_id === values[0]).length }] };
    }
    if (statement.startsWith("select count(*)::integer as total from workspace_drafts")) {
      return { rows: [{ total: drafts.filter((draft) => draft.workspace_id === values[0]).length }] };
    }
    if (statement.startsWith("insert into workspace_topics")) {
      const topic = {
        id: values[0], workspace_id: values[1], title: values[2], vertical: values[3], equipment: values[4], pain: values[5],
        content_type: values[6], status: "Suggested", created_at: new Date(), updated_at: new Date()
      };
      topics.push(topic);
      return { rows: [{ id: topic.id, title: topic.title, vertical: topic.vertical, equipment: topic.equipment, pain: topic.pain, content_type: topic.content_type, status: topic.status, created_at: topic.created_at, updated_at: topic.updated_at }] };
    }
    if (statement.startsWith("insert into workspace_drafts")) {
      const draft = {
        id: values[0], workspace_id: values[1], topic_id: values[2], title: values[3], body: values[4], status: "Draft",
        version: 1, created_by: values[5], updated_by: values[6], reviewed_by: null, reviewed_at: null,
        created_at: new Date(), updated_at: new Date()
      };
      drafts.push(draft);
      return { rows: [{ ...draft }] };
    }
    if (statement.startsWith("select id, title, vertical, equipment, pain, content_type, status, created_at, updated_at from workspace_topics")) {
      return { rows: topics.filter((topic) => topic.workspace_id === values[0]) };
    }
    if (statement.startsWith("select id, topic_id, title, status, version, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at from workspace_drafts")) {
      return { rows: drafts.filter((draft) => draft.workspace_id === values[0]).slice(0, values[1]) };
    }
    if (statement.includes("from workspace_drafts where id = $1 and workspace_id = $2")) {
      return { rows: drafts.filter((draft) => draft.id === values[0] && draft.workspace_id === values[1]).map((draft) => ({ ...draft })) };
    }
    if (statement.startsWith("select id, draft_id, author_id, action, comment, created_at from draft_feedback")) {
      return { rows: feedback.filter((item) => item.workspace_id === values[0]) };
    }
    if (statement.startsWith("update workspace_drafts set title")) {
      const draft = drafts.find((item) => item.id === values[3] && item.workspace_id === values[4]
        && ["Draft", "Changes requested", "Approved"].includes(item.status)
        && (!values[5] || item.topic_id === values[5]));
      if (!draft) return { rows: [] };
      draft.title = values[0];
      draft.body = values[1];
      if (draft.status === "Approved") draft.status = "Draft";
      draft.version += 1;
      draft.updated_by = values[2];
      draft.reviewed_by = null;
      draft.reviewed_at = null;
      draft.updated_at = new Date();
      return { rows: [{ ...draft }] };
    }
    if (statement.startsWith("update workspace_drafts set status = 'in review'")) {
      const draft = drafts.find((item) => item.id === values[0] && item.workspace_id === values[1] && ["Draft", "Changes requested"].includes(item.status));
      if (!draft) return { rows: [] };
      draft.status = "In review";
      return { rows: [{ id: draft.id }] };
    }
    if (statement.startsWith("update workspace_drafts set status = $1")) {
      const draft = drafts.find((item) => item.id === values[2] && item.workspace_id === values[3] && item.status === "In review");
      if (!draft) return { rows: [] };
      draft.status = values[0];
      draft.reviewed_by = values[1];
      draft.reviewed_at = new Date();
      return { rows: [{ id: draft.id }] };
    }
    if (statement.startsWith("insert into draft_feedback")) {
      feedback.push({ id: values[0], workspace_id: values[1], draft_id: values[2], author_id: values[3], action: values[4], comment: values[5], created_at: new Date() });
      return { rows: [] };
    }
    if (statement.startsWith("insert into workspace_audit_events")) return { rows: [] };
    if (statement.startsWith("insert into stripe_webhook_events")) {
      if (stripeEvents.includes(values[0])) return { rows: [] };
      stripeEvents.push(values[0]);
      return { rows: [{ event_id: values[0] }] };
    }
    if (statement.startsWith("insert into workspace_subscriptions (workspace_id, checkout_attempt_key")) {
      const current = subscriptions.find((item) => item.workspace_id === values[0]);
      const checkout = {
        workspace_id: values[0],
        status: current ? current.status : "inactive",
        checkout_attempt_key: values[1],
        checkout_plan: values[2],
        checkout_expires_at: values[3]
      };
      if (current) Object.assign(current, checkout);
      else subscriptions.push(checkout);
      return { rows: [] };
    }
    if (statement.startsWith("insert into workspace_subscriptions (workspace_id, status)")) {
      const current = subscriptions.find((item) => item.workspace_id === values[0]);
      if (!current) {
        subscriptions.push({ workspace_id: values[0], status: values[1] || "trialing" });
      }
      return { rows: [] };
    }
    if (statement.startsWith("insert into workspace_subscriptions")) {
      const current = subscriptions.find((item) => item.workspace_id === values[0]);
      const subscription = {
        workspace_id: values[0],
        stripe_customer_id: values[1],
        stripe_subscription_id: values[2],
        stripe_price_id: values[3],
        status: values[4],
        current_period_end: values[5]
      };
      if (current) Object.assign(current, subscription, {
        checkout_attempt_key: null,
        checkout_plan: null,
        checkout_session_id: null,
        checkout_expires_at: null
      });
      else subscriptions.push(subscription);
      return { rows: [] };
    }
    if (statement.startsWith("select status, stripe_customer_id, checkout_attempt_key, checkout_plan, checkout_expires_at from workspace_subscriptions")) {
      return { rows: subscriptions
        .filter((item) => item.workspace_id === values[0])
        .map(({ status, stripe_customer_id, checkout_attempt_key, checkout_plan, checkout_expires_at }) => ({
          status,
          stripe_customer_id,
          checkout_attempt_key,
          checkout_plan,
          checkout_expires_at
        })) };
    }
    if (statement.startsWith("update workspace_subscriptions set checkout_session_id")) {
      const subscription = subscriptions.find((item) => item.workspace_id === values[2] && item.checkout_attempt_key === values[3]);
      if (subscription) {
        subscription.checkout_session_id = values[0];
        subscription.checkout_expires_at = values[1];
      }
      return { rows: [] };
    }
    if (statement.startsWith("select status, current_period_end from workspace_subscriptions")) {
      return { rows: subscriptions.filter((item) => item.workspace_id === values[0]).map(({ status, current_period_end }) => ({ status, current_period_end })) };
    }
    if (statement.startsWith("select status from workspace_subscriptions")) {
      return { rows: subscriptions.filter((item) => item.workspace_id === values[0]).map(({ status }) => ({ status })) };
    }
    if (statement.startsWith("select stripe_customer_id from workspace_subscriptions")) {
      return { rows: subscriptions.filter((item) => item.workspace_id === values[0]).map(({ stripe_customer_id }) => ({ stripe_customer_id })) };
    }
    if (statement.startsWith("select id from users where email = $1 and email_verified_at is not null")) {
      return { rows: users.filter((user) => user.email === values[0] && user.email_verified_at).map(({ id }) => ({ id })) };
    }
    if (statement.startsWith("update users set email_verified_at = now()")) {
      const user = users.find((item) =>
        item.email_verification_token_hash === values[0]
        && item.email_verification_expires_at > new Date()
        && !item.email_verified_at
      );
      if (!user) return { rows: [] };
      user.email_verified_at = new Date();
      user.email_verification_token_hash = null;
      user.email_verification_expires_at = null;
      return { rows: [{ id: user.id }] };
    }
    if (statement.startsWith("update users set email_verification_token_hash")) {
      const user = users.find((item) => item.id === values[2] && !item.email_verified_at);
      if (user) {
        user.email_verification_token_hash = values[0];
        user.email_verification_expires_at = values[1];
      }
      return { rows: [] };
    }
    if (statement.startsWith("select id from users where email")) {
      return { rows: users.filter((user) => user.email === values[0]).map(({ id }) => ({ id })) };
    }
    if (statement.startsWith("update workspace_memberships set role")) {
      const membership = memberships.find((item) => item.workspace_id === values[1] && item.user_id === values[2]);
      if (membership) membership.role = values[0];
      return { rows: [] };
    }
    if (statement.startsWith("update workspaces set name")) {
      const workspace = workspaces.find((item) => item.id === values[2]);
      if (!workspace) return { rows: [] };
      workspace.name = values[0];
      workspace.website = values[1];
      return { rows: [{ ...workspace }] };
    }
    if (statement.startsWith("update workspaces set plan")) {
      const workspace = workspaces.find((item) => item.id === values[1]);
      if (workspace) workspace.plan = values[0];
      return { rows: [] };
    }
    if (statement.startsWith("delete from workspace_memberships")) {
      const index = memberships.findIndex((item) => item.workspace_id === values[0] && item.user_id === values[1]);
      if (index >= 0) memberships.splice(index, 1);
      return { rows: [] };
    }
    return { rows: [] };
  }

  return {
    query,
    connect: async () => ({ query, release() {} })
  };
}

async function startTestServer(t, pool = { query: async () => ({ rows: [] }) }, sentEmails = [], appOptions = {}) {
  const app = createApp({
    pool,
    sessionSecret: "test-session-secret-with-more-than-32-bytes",
    sessionStore: new session.MemoryStore(),
    sendVerificationEmail: async (message) => sentEmails.push({ type: "verification", ...message }),
    sendPasswordResetEmail: async (message) => sentEmails.push({ type: "password-reset", ...message }),
    sendPasswordChangedEmail: async (message) => sentEmails.push({ type: "password-changed", ...message }),
    sendWorkspaceInvitation: async (message) => sentEmails.push({ type: "invitation", ...message }),
    ...appOptions
  });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

async function registerAccount(baseUrl, email, workspaceName) {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  const sessionCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await csrfResponse.json();
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: email.split("@")[0],
      email,
      password: "correct horse battery staple",
      workspaceName,
      industry: "Steel"
    })
  });
  assert.equal(response.status, 202);
  return response.json();
}

async function verifyAccount(baseUrl, token) {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  const sessionCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await csrfResponse.json();
  return fetch(`${baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ token })
  });
}

async function loginAccount(baseUrl, email, password) {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  const sessionCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await csrfResponse.json();
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });
  return {
    response,
    body: await response.json(),
    cookie: (response.headers.get("set-cookie") || `${sessionCookie};`).split(";")[0]
  };
}

async function apiRequest(baseUrl, account, path, method = "GET", body) {
  const headers = { Cookie: account.cookie };
  if (method !== "GET") {
    headers.Origin = baseUrl;
    headers["X-CSRF-Token"] = account.csrfToken;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const isJson = response.headers.get("content-type") && response.headers.get("content-type").includes("application/json");
  return { response, body: response.status === 204 ? null : (isJson ? await response.json() : await response.text()) };
}

async function anonymousPost(baseUrl, path, body) {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  const sessionCookie = csrfResponse.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await csrfResponse.json();
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return {
    response,
    body: await response.json(),
    cookie: (response.headers.get("set-cookie") || `${sessionCookie};`).split(";")[0]
  };
}

function getLinkToken(url, parameter) {
  const parsed = new URL(url);
  return new URLSearchParams(parsed.hash.slice(1)).get(parameter) || parsed.searchParams.get(parameter);
}

test("registration validation enforces required fields and password bounds", () => {
  const valid = validateRegistration({
    name: " Ada Lovelace ",
    email: " ADA@example.com ",
    password: "correct horse battery staple",
    workspaceName: " Analytical Engines ",
    industry: "Industrial"
  });
  assert.deepEqual(valid, {
    name: "Ada Lovelace",
    email: "ada@example.com",
    password: "correct horse battery staple",
    workspaceName: "Analytical Engines",
    industry: "Industrial"
  });
  assert.equal(validateRegistration({ ...valid, password: "short" }), null);
  assert.equal(validateRegistration({ ...valid, email: "not-an-email" }), null);
  assert.equal(validateRegistration({ ...valid, workspaceName: " " }), null);
});

test("workspace validation rejects missing or oversized values", () => {
  assert.deepEqual(validateWorkspace({ name: " Team ", industry: "Steel" }), {
    name: "Team",
    industry: "Steel",
    kind: "standard"
  });
  assert.equal(validateWorkspace({ name: "Team", industry: "Steel", kind: "untrusted" }), null);
  assert.equal(validateWorkspace({ name: "Team", industry: "" }), null);
  assert.equal(validateWorkspace({ name: "x".repeat(121), industry: "Steel" }), null);
  assert.deepEqual(validateWorkspaceUpdate({ name: "Team", website: "team.example" }), {
    name: "Team",
    website: "team.example"
  });
  assert.equal(validateWorkspaceUpdate({ name: "Team", website: "x".repeat(256) }), null);
});

test("passwords use Argon2id and verify legacy scrypt hashes without storing plaintext", async () => {
  const firstHash = await hashPassword("correct horse battery staple");
  const secondHash = await hashPassword("correct horse battery staple");
  assert.match(firstHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword("correct horse battery staple", firstHash), true);
  assert.equal(await verifyPassword("incorrect password", firstHash), false);
  assert.equal(await verifyPassword("correct horse battery staple", "plain-text"), false);

  const salt = crypto.randomBytes(16);
  const legacyHash = await promisify(crypto.scrypt)("legacy password", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  assert.equal(await verifyPassword("legacy password", `scrypt$${salt.toString("hex")}$${legacyHash.toString("hex")}`), true);
});

test("the server rejects weak session secrets", () => {
  assert.throws(() => createApp({ pool: {}, sessionSecret: "short" }), /at least 32 bytes/);
});

test("production requires HTTPS and trusts only configured proxy addresses", async (t) => {
  const app = createApp({
    pool: { query: async () => ({ rows: [] }) },
    sessionSecret: "test-session-secret-with-more-than-32-bytes",
    production: true,
    appOrigin: "https://rankforge.example",
    sessionStore: new session.MemoryStore()
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const direct = await fetch(`${baseUrl}/`);
  assert.equal(direct.status, 426);
  const spoofedProxyHeader = await fetch(`${baseUrl}/`, { headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(spoofedProxyHeader.status, 426);
  const healthProbe = await fetch(`${baseUrl}/health/ready`);
  assert.equal(healthProbe.status, 200);

  app.set("trust proxy", "loopback");
  const trustedProxy = await fetch(`${baseUrl}/`, { headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(trustedProxy.status, 200);
});

test("API requires authentication and CSRF verification and does not expose server files", async (t) => {
  const baseUrl = await startTestServer(t);

  const unauthenticated = await fetch(`${baseUrl}/api/me`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("x-content-type-options"), "nosniff");
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");

  const homepage = await fetch(`${baseUrl}/`);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /RankForge AI/);

  const sourceFile = await fetch(`${baseUrl}/server.js`);
  assert.equal(sourceFile.status, 404);

  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  assert.equal(csrfResponse.status, 200);
  const { csrfToken } = await csrfResponse.json();
  const sessionCookie = csrfResponse.headers.get("set-cookie").split(";")[0];

  const blocked = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  assert.equal(blocked.status, 403);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken
    }
  });
  assert.equal(logout.status, 204);
});

test("workspace APIs isolate members and enforce membership-management roles", async (t) => {
  const sentEmails = [];
  const baseUrl = await startTestServer(t, createFakePool(), sentEmails);
  const pendingOwner = await registerAccount(baseUrl, "owner@example.com", "Owner workspace");
  const duplicateOwner = await registerAccount(baseUrl, "owner@example.com", "Duplicate workspace");
  assert.equal(duplicateOwner.message, pendingOwner.message);
  assert.equal(sentEmails.length, 1);
  const ownerToken = getLinkToken(sentEmails[0].url, "verify");
  assert.equal((await loginAccount(baseUrl, "owner@example.com", "correct horse battery staple")).response.status, 401);
  assert.equal((await verifyAccount(baseUrl, ownerToken)).status, 200);
  assert.equal((await verifyAccount(baseUrl, ownerToken)).status, 400);
  const signedInOwner = await loginAccount(baseUrl, "owner@example.com", "correct horse battery staple");
  assert.equal(signedInOwner.response.status, 200);
  const owner = await apiRequest(baseUrl, signedInOwner, "/api/me");
  const ownerSession = {
    ...signedInOwner.body,
    cookie: signedInOwner.cookie
  };

  await registerAccount(baseUrl, "other@example.com", "Other workspace");
  const otherToken = getLinkToken(sentEmails[1].url, "verify");
  const pendingInvitation = await apiRequest(
    baseUrl,
    ownerSession,
    `/api/workspaces/${owner.body.workspaces[0].id}/invitations`,
    "POST",
    { email: "other@example.com", role: "editor" }
  );
  assert.equal(pendingInvitation.response.status, 202);
  assert.equal((await verifyAccount(baseUrl, otherToken)).status, 200);

  const signedInOther = await loginAccount(baseUrl, "other@example.com", "correct horse battery staple");
  assert.equal(signedInOther.response.status, 200);
  const other = await apiRequest(baseUrl, signedInOther, "/api/me");
  const otherSession = { ...signedInOther.body, cookie: signedInOther.cookie };
  const invitationEmail = sentEmails.find((message) => message.type === "invitation");
  const acceptedInvitation = await apiRequest(
    baseUrl,
    otherSession,
    "/api/invitations/accept",
    "POST",
    { token: getLinkToken(invitationEmail.url, "invite") }
  );
  assert.equal(acceptedInvitation.response.status, 200);
  const clientWorkspace = await apiRequest(baseUrl, ownerSession, "/api/workspaces", "POST", {
    name: "Client workspace",
    industry: "Steel",
    kind: "client"
  });
  assert.equal(clientWorkspace.response.status, 201);
  assert.equal(clientWorkspace.body.kind, "client");
  const accountWorkspaces = await apiRequest(baseUrl, ownerSession, "/api/me");
  assert.ok(accountWorkspaces.body.workspaces.some((workspace) => workspace.kind === "client"));

  const isolated = await apiRequest(baseUrl, ownerSession, `/api/workspaces/${other.body.workspaces[0].id}/members`);
  assert.equal(isolated.response.status, 404);

  const ownerMembers = await apiRequest(baseUrl, ownerSession, `/api/workspaces/${owner.body.workspaces[0].id}/members`);
  assert.equal(ownerMembers.response.status, 200);
  assert.deepEqual(ownerMembers.body.members.map((member) => member.role).sort(), ["Editor", "Owner"]);

  const editorAccess = await apiRequest(baseUrl, otherSession, `/api/workspaces/${owner.body.workspaces[0].id}/members`);
  assert.equal(editorAccess.response.status, 200);
  const editorManage = await apiRequest(
    baseUrl,
    otherSession,
    `/api/workspaces/${owner.body.workspaces[0].id}/invitations`,
    "POST",
    { email: "owner@example.com", role: "reviewer" }
  );
  assert.equal(editorManage.response.status, 403);

  const ownerUpdate = await apiRequest(
    baseUrl,
    ownerSession,
    `/api/workspaces/${owner.body.workspaces[0].id}`,
    "PATCH",
    { name: "Renamed workspace", website: "renamed.example" }
  );
  assert.equal(ownerUpdate.response.status, 200);
  assert.equal(ownerUpdate.body.name, "Renamed workspace");

  const editorUpdate = await apiRequest(
    baseUrl,
    otherSession,
    `/api/workspaces/${owner.body.workspaces[0].id}`,
    "PATCH",
    { name: "Unauthorized rename", website: "" }
  );
  assert.equal(editorUpdate.response.status, 403);
});

test("password recovery uses generic responses, one-time tokens, and invalidates prior sessions", async (t) => {
  const sentEmails = [];
  const baseUrl = await startTestServer(t, createFakePool(), sentEmails);
  await registerAccount(baseUrl, "reset@example.com", "Reset workspace");
  const verifyToken = getLinkToken(sentEmails[0].url, "verify");
  assert.equal((await verifyAccount(baseUrl, verifyToken)).status, 200);
  const oldLogin = await loginAccount(baseUrl, "reset@example.com", "correct horse battery staple");
  assert.equal(oldLogin.response.status, 200);
  const oldSession = { ...oldLogin.body, cookie: oldLogin.cookie };

  const unknown = await anonymousPost(baseUrl, "/auth/forgot-password", { email: "missing@example.com" });
  const known = await anonymousPost(baseUrl, "/auth/forgot-password", { email: "reset@example.com" });
  assert.equal(unknown.response.status, 202);
  assert.equal(known.response.status, 202);
  assert.equal(unknown.body.message, known.body.message);
  const resetEmail = sentEmails.find((message) => message.type === "password-reset");
  const resetToken = getLinkToken(resetEmail.url, "reset");

  const reset = await anonymousPost(baseUrl, "/auth/reset-password", {
    token: resetToken,
    password: "a different and longer password"
  });
  assert.equal(reset.response.status, 200);
  assert.equal((await anonymousPost(baseUrl, "/auth/reset-password", {
    token: resetToken,
    password: "another different password"
  })).response.status, 400);
  assert.equal((await apiRequest(baseUrl, oldSession, "/api/me")).response.status, 401);
  assert.equal((await loginAccount(baseUrl, "reset@example.com", "correct horse battery staple")).response.status, 401);
  assert.equal((await loginAccount(baseUrl, "reset@example.com", "a different and longer password")).response.status, 200);
  assert.ok(sentEmails.some((message) => message.type === "password-changed"));
});

test("workspace content persists and authorization is checked per operation", async (t) => {
  const sentEmails = [];
  const baseUrl = await startTestServer(t, createFakePool(), sentEmails);
  await registerAccount(baseUrl, "writer@example.com", "Writer workspace");
  const verifyToken = getLinkToken(sentEmails[0].url, "verify");
  await verifyAccount(baseUrl, verifyToken);
  const writerLogin = await loginAccount(baseUrl, "writer@example.com", "correct horse battery staple");
  const writer = { ...writerLogin.body, cookie: writerLogin.cookie };
  const account = await apiRequest(baseUrl, writer, "/api/me");
  const workspaceId = account.body.workspaces[0].id;

  await registerAccount(baseUrl, "viewer@example.com", "Viewer workspace");
  await verifyAccount(baseUrl, getLinkToken(sentEmails[1].url, "verify"));
  const viewerLogin = await loginAccount(baseUrl, "viewer@example.com", "correct horse battery staple");
  const viewer = { ...viewerLogin.body, cookie: viewerLogin.cookie };
  const inviteResult = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/invitations`, "POST", {
    email: "viewer@example.com",
    role: "client_viewer"
  });
  assert.equal(inviteResult.response.status, 202);
  const invitationMail = sentEmails.find((message) => message.type === "invitation");
  const viewerAccept = await apiRequest(baseUrl, viewer, "/api/invitations/accept", "POST", { token: getLinkToken(invitationMail.url, "invite") });
  assert.equal(viewerAccept.response.status, 200);

  const topic = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/topics`, "POST", {
    title: "Pump maintenance planning",
    vertical: "Food & Beverage",
    equipment: "Centrifugal pumps",
    pain: "Unplanned downtime",
    type: "Solution page"
  });
  assert.equal(topic.response.status, 201);
  const draft = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/drafts`, "POST", {
    topicId: topic.body.id,
    title: topic.body.title,
    content: "Persistent draft content."
  });
  assert.equal(draft.response.status, 201);
  assert.equal((await apiRequest(baseUrl, viewer, `/api/workspaces/${workspaceId}/content`)).response.status, 200);
  const viewerWrite = await apiRequest(baseUrl, viewer, `/api/workspaces/${workspaceId}/topics`, "POST", {
    title: "Not allowed",
    vertical: "Steel"
  });
  assert.equal(viewerWrite.response.status, 403);

  const submission = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/drafts/${draft.body.id}/submit`, "POST", {});
  assert.equal(submission.response.status, 204);
  const review = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/drafts/${draft.body.id}/review`, "POST", {
    action: "approved",
    comment: ""
  });
  assert.equal(review.response.status, 204);
  const saved = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/drafts/${draft.body.id}`);
  assert.equal(saved.body.content, "Persistent draft content.");
  assert.equal(saved.body.status, "Approved");

  const exported = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/drafts/${draft.body.id}/export`);
  assert.equal(exported.response.status, 200);

  const del = await apiRequest(baseUrl, writer, `/api/workspaces/${workspaceId}/topics/${topic.body.id}`, "DELETE");
  assert.equal(del.response.status, 200);

  const foreignWorkspace = await apiRequest(baseUrl, writer, "/api/workspaces/00000000-0000-4000-8000-000000000000/content");
  assert.equal(foreignWorkspace.response.status, 404);
});

test("workspace invitations are single-use, role-bound, and tied to the invited email", async (t) => {
  const sentEmails = [];
  const baseUrl = await startTestServer(t, createFakePool(), sentEmails);
  await registerAccount(baseUrl, "owner-invite@example.com", "Invitation workspace");
  await registerAccount(baseUrl, "invitee@example.com", "Invitee workspace");
  await registerAccount(baseUrl, "outsider@example.com", "Outsider workspace");
  await verifyAccount(baseUrl, getLinkToken(sentEmails[0].url, "verify"));
  await verifyAccount(baseUrl, getLinkToken(sentEmails[1].url, "verify"));
  await verifyAccount(baseUrl, getLinkToken(sentEmails[2].url, "verify"));
  const ownerLogin = await loginAccount(baseUrl, "owner-invite@example.com", "correct horse battery staple");
  const inviteeLogin = await loginAccount(baseUrl, "invitee@example.com", "correct horse battery staple");
  const outsiderLogin = await loginAccount(baseUrl, "outsider@example.com", "correct horse battery staple");
  const owner = { ...ownerLogin.body, cookie: ownerLogin.cookie };
  const invitee = { ...inviteeLogin.body, cookie: inviteeLogin.cookie };
  const outsider = { ...outsiderLogin.body, cookie: outsiderLogin.cookie };
  const ownerInfo = await apiRequest(baseUrl, owner, "/api/me");
  const workspaceId = ownerInfo.body.workspaces[0].id;

  const invitation = await apiRequest(baseUrl, owner, `/api/workspaces/${workspaceId}/invitations`, "POST", {
    email: "invitee@example.com",
    role: "reviewer"
  });
  assert.equal(invitation.response.status, 202);
  const inviteEmail = sentEmails.find((message) => message.type === "invitation");
  const token = getLinkToken(inviteEmail.url, "invite");
  assert.equal((await apiRequest(baseUrl, outsider, "/api/invitations/accept", "POST", { token })).response.status, 400);
  const accepted = await apiRequest(baseUrl, invitee, "/api/invitations/accept", "POST", { token });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.workspaceId, workspaceId);
  assert.equal((await apiRequest(baseUrl, invitee, `/api/workspaces/${workspaceId}/content`)).response.status, 200);
  assert.equal((await apiRequest(baseUrl, invitee, "/api/invitations/accept", "POST", { token })).response.status, 400);

  const newAccountInvite = await apiRequest(baseUrl, owner, `/api/workspaces/${workspaceId}/invitations`, "POST", {
    email: "new-person@example.com",
    role: "editor"
  });
  assert.equal(newAccountInvite.response.status, 202);
  const newInviteEmail = sentEmails.find((message) => message.type === "invitation" && message.email === "new-person@example.com");
  const registration = await anonymousPost(baseUrl, "/invitations/register", {
    token: getLinkToken(newInviteEmail.url, "invite"),
    name: "New Person",
    email: "new-person@example.com",
    password: "a secure invitation password"
  });
  assert.equal(registration.response.status, 201);
  const newMember = { ...registration.body, cookie: registration.cookie };
  const newMemberAccount = await apiRequest(baseUrl, newMember, "/api/me");
  assert.equal(newMemberAccount.response.status, 200);
  assert.ok(newMemberAccount.body.workspaces.some((workspace) => workspace.id === workspaceId));
});

test("Stripe checkout retries reuse one idempotency key and reject conflicting plans", async (t) => {
  const sentEmails = [];
  const checkoutCalls = [];
  const sessionsByKey = new Map();
  const stripeClient = {
    checkout: {
      sessions: {
        create: async (params, options) => {
          checkoutCalls.push({ params, options });
          if (!sessionsByKey.has(options.idempotencyKey)) {
            sessionsByKey.set(options.idempotencyKey, {
              id: `cs_${sessionsByKey.size + 1}`,
              url: `https://checkout.stripe.test/${sessionsByKey.size + 1}`,
              status: "open",
              expires_at: Math.floor(Date.now() / 1000) + 3600
            });
          }
          return sessionsByKey.get(options.idempotencyKey);
        }
      }
    }
  };
  const baseUrl = await startTestServer(t, createFakePool(), sentEmails, {
    stripeClient,
    stripePriceIds: { Starter: "price_starter", Growth: "price_growth" }
  });
  await registerAccount(baseUrl, "checkout@example.com", "Checkout workspace");
  await verifyAccount(baseUrl, getLinkToken(sentEmails[0].url, "verify"));
  const login = await loginAccount(baseUrl, "checkout@example.com", "correct horse battery staple");
  const owner = { ...login.body, cookie: login.cookie };
  const account = await apiRequest(baseUrl, owner, "/api/me");
  const workspaceId = account.body.workspaces[0].id;

  const first = await apiRequest(baseUrl, owner, `/api/workspaces/${workspaceId}/billing/checkout`, "POST", { plan: "Starter" });
  const retry = await apiRequest(baseUrl, owner, `/api/workspaces/${workspaceId}/billing/checkout`, "POST", { plan: "Starter" });
  assert.equal(first.response.status, 200);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.url, first.body.url);
  assert.equal(sessionsByKey.size, 1);
  assert.equal(checkoutCalls[0].options.idempotencyKey, checkoutCalls[1].options.idempotencyKey);

  const conflicting = await apiRequest(baseUrl, owner, `/api/workspaces/${workspaceId}/billing/checkout`, "POST", { plan: "Growth" });
  assert.equal(conflicting.response.status, 409);
  assert.equal(sessionsByKey.size, 1);
});

test("Stripe webhooks require signatures, deduplicate events, and update subscription state", async (t) => {
  const sentEmails = [];
  const secret = "whsec_rankforge_test_secret";
  const stripe = new Stripe("sk_test_rankforge");
  const baseUrl = await startTestServer(t, createFakePool(), sentEmails, {
    stripeClient: stripe,
    stripeWebhookSecret: secret,
    stripePriceIds: { Starter: "price_starter", Growth: "price_growth" }
  });
  await registerAccount(baseUrl, "billing@example.com", "Billing workspace");
  await verifyAccount(baseUrl, getLinkToken(sentEmails[0].url, "verify"));
  const login = await loginAccount(baseUrl, "billing@example.com", "correct horse battery staple");
  const account = { ...login.body, cookie: login.cookie };
  const accountInfo = await apiRequest(baseUrl, account, "/api/me");
  const workspaceId = accountInfo.body.workspaces[0].id;
  const event = {
    id: "evt_subscription_update",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_rankforge",
        customer: "cus_rankforge",
        metadata: { workspace_id: workspaceId },
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        items: { data: [{ price: { id: "price_growth" } }] }
      }
    }
  };
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const invalid = await fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": "invalid" },
    body: payload
  });
  assert.equal(invalid.status, 400);

  const sendWebhook = () => fetch(`${baseUrl}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload
  });
  const accepted = await sendWebhook();
  assert.equal(accepted.status, 200);
  assert.equal((await apiRequest(baseUrl, account, "/api/me")).body.workspaces[0].plan, "Growth");
  const duplicate = await sendWebhook();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
});

test("local development allows Live Server origins with CORS while untrusted origins remain blocked", async (t) => {
  const baseUrl = await startTestServer(t);
  const liveServerOrigin = "http://127.0.0.1:5500";
  const untrustedOrigin = "https://untrusted-attacker.com";

  // Preflight OPTIONS request from Live Server
  const preflight = await fetch(`${baseUrl}/api/csrf`, {
    method: "OPTIONS",
    headers: {
      Origin: liveServerOrigin,
      "Access-Control-Request-Method": "GET"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), liveServerOrigin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");

  // GET /api/csrf from Live Server
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`, {
    headers: { Origin: liveServerOrigin }
  });
  assert.equal(csrfResponse.status, 200);
  assert.equal(csrfResponse.headers.get("access-control-allow-origin"), liveServerOrigin);
  const { csrfToken } = await csrfResponse.json();
  const sessionCookie = csrfResponse.headers.get("set-cookie").split(";")[0];

  // POST with valid CSRF token from Live Server succeeds past requireCsrf
  const postFromLiveServer = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      Origin: liveServerOrigin,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken
    }
  });
  assert.equal(postFromLiveServer.status, 204);

  // Untrusted origin gets no CORS header and is blocked by requireCsrf
  const untrustedCsrf = await fetch(`${baseUrl}/api/csrf`, {
    headers: { Origin: untrustedOrigin }
  });
  assert.equal(untrustedCsrf.headers.get("access-control-allow-origin"), null);

  const blockedUntrusted = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      Origin: untrustedOrigin,
      Cookie: sessionCookie,
      "X-CSRF-Token": csrfToken
    }
  });
  assert.equal(blockedUntrusted.status, 403);
});
