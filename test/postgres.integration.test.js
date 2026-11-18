const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const { Pool } = require("pg");
const { applyMigrations } = require("../db/migrations");
const { createPostgresPoolConfig } = require("../db/postgres");
const { createApp } = require("../server");

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !/_test$/i.test(new URL(databaseUrl).pathname.slice(1))) {
  throw new Error("TEST_DATABASE_URL must point to a dedicated database whose name ends with _test.");
}

async function getCsrf(baseUrl) {
  const response = await fetch(`${baseUrl}/api/csrf`);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const body = await response.json();
  return { cookie, csrfToken: body.csrfToken };
}

async function postJson(baseUrl, path, body, session) {
  const context = session || await getCsrf(baseUrl);
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Origin: baseUrl,
      Cookie: context.cookie,
      "X-CSRF-Token": context.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

async function registerAndVerify(baseUrl, sentEmails, email) {
  const registration = await postJson(baseUrl, "/api/auth/register", {
    name: email.split("@")[0],
    email,
    password: "a secure integration password",
    workspaceName: `${email.split("@")[0]} workspace`,
    industry: "Steel"
  });
  assert.equal(registration.response.status, 202);
  const verificationEmail = sentEmails.findLast((message) => message.type === "verification" && message.email === email);
  assert.ok(verificationEmail);
  const token = new URLSearchParams(new URL(verificationEmail.url).hash.slice(1)).get("verify");
  assert.equal((await postJson(baseUrl, "/api/auth/verify-email", { token })).response.status, 200);
}

async function login(baseUrl, email) {
  const anonymous = await getCsrf(baseUrl);
  const result = await postJson(baseUrl, "/api/auth/login", {
    email,
    password: "a secure integration password"
  }, anonymous);
  assert.equal(result.response.status, 200);
  return {
    cookie: result.response.headers.get("set-cookie").split(";")[0],
    csrfToken: result.body.csrfToken
  };
}

test("PostgreSQL migrations, sessions, tenant authorization, and draft review work against a real database", {
  skip: !databaseUrl && "Set TEST_DATABASE_URL to run real PostgreSQL integration tests."
}, async (t) => {
  const pool = new Pool(createPostgresPoolConfig({
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_SSL_MODE: process.env.TEST_DATABASE_SSL_MODE || "disable"
  }));
  const suffix = crypto.randomUUID();
  const emails = [`owner-${suffix}@integration.invalid`, `viewer-${suffix}@integration.invalid`];
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      const users = await pool.query("SELECT id FROM users WHERE email = ANY($1::text[])", [emails]);
      for (const { id } of users.rows) {
        await pool.query(
          "DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM workspace_memberships WHERE user_id = $1)",
          [id]
        );
        await pool.query("DELETE FROM user_sessions WHERE sess->>'userId' = $1", [id]);
        await pool.query("DELETE FROM users WHERE id = $1", [id]);
      }
    } finally {
      await pool.end();
    }
  });

  await applyMigrations(pool);
  const sentEmails = [];
  const app = createApp({
    pool,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    production: false,
    trustProxy: false,
    appOrigin: "http://localhost",
    sendVerificationEmail: async (message) => sentEmails.push({ type: "verification", ...message }),
    sendWorkspaceInvitation: async (message) => sentEmails.push({ type: "invitation", ...message })
  });
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const [ownerEmail, viewerEmail] = emails;

  await registerAndVerify(baseUrl, sentEmails, ownerEmail);
  await registerAndVerify(baseUrl, sentEmails, viewerEmail);
  const owner = await login(baseUrl, ownerEmail);
  const viewer = await login(baseUrl, viewerEmail);

  const ownerAccount = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: owner.cookie } });
  const viewerAccount = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: viewer.cookie } });
  assert.equal(ownerAccount.status, 200);
  assert.equal(viewerAccount.status, 200);
  const ownerData = await ownerAccount.json();
  const viewerData = await viewerAccount.json();
  const workspaceId = ownerData.workspaces[0].id;

  const invitation = await postJson(baseUrl, `/api/workspaces/${workspaceId}/invitations`, {
    email: viewerEmail,
    role: "client_viewer"
  }, owner);
  assert.equal(invitation.response.status, 202);
  const invitationEmail = sentEmails.findLast((message) => message.type === "invitation" && message.email === viewerEmail);
  const invitationToken = new URLSearchParams(new URL(invitationEmail.url).hash.slice(1)).get("invite");
  const accepted = await postJson(baseUrl, "/api/invitations/accept", { token: invitationToken }, viewer);
  assert.equal(accepted.response.status, 200);

  const topic = await postJson(baseUrl, `/api/workspaces/${workspaceId}/topics`, {
    title: "Integration test topic",
    vertical: "Steel",
    equipment: "Rolling mill",
    pain: "Unplanned downtime"
  }, owner);
  assert.equal(topic.response.status, 201);
  const draft = await postJson(baseUrl, `/api/workspaces/${workspaceId}/drafts`, {
    topicId: topic.body.id,
    title: topic.body.title,
    content: "Persisted by PostgreSQL."
  }, owner);
  assert.equal(draft.response.status, 201);
  const submitted = await postJson(baseUrl, `/api/workspaces/${workspaceId}/drafts/${draft.body.id}/submit`, {}, owner);
  assert.equal(submitted.response.status, 204);
  const reviewed = await postJson(baseUrl, `/api/workspaces/${workspaceId}/drafts/${draft.body.id}/review`, {
    action: "approved",
    comment: ""
  }, owner);
  assert.equal(reviewed.response.status, 204);

  const saved = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/drafts/${draft.body.id}`, {
    headers: { Cookie: owner.cookie }
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).content, "Persisted by PostgreSQL.");
  const viewerWrite = await postJson(baseUrl, `/api/workspaces/${workspaceId}/topics`, {
    title: "Viewer must not write",
    vertical: "Steel"
  }, viewer);
  assert.equal(viewerWrite.response.status, 403);
  const foreignWorkspace = await fetch(`${baseUrl}/api/workspaces/${viewerData.workspaces[0].id}/content`, {
    headers: { Cookie: owner.cookie }
  });
  assert.equal(foreignWorkspace.status, 404);
});
