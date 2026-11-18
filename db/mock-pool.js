const crypto = require("crypto");

function createDevMockPool() {
  const users = [];
  const workspaces = [
    {
      id: "dev-workspace-001",
      name: "Northstar Manufacturing",
      industry: "Food & Beverage",
      website: "https://northstarindustrial.com",
      workspace_type: "standard",
      plan: "Starter"
    }
  ];
  const memberships = [];
  const topics = [
    {
      id: "dev-topic-001",
      workspace_id: "dev-workspace-001",
      title: "Predictive Maintenance for Industrial Chillers",
      vertical: "HVAC",
      equipment: "Centrifugal Chillers",
      pain: "Compressor bearing failure and refrigerant leaks",
      content_type: "Technical guide",
      status: "Suggested",
      batch_id: null,
      created_at: new Date(),
      updated_at: new Date()
    },
    {
      id: "dev-topic-002",
      workspace_id: "dev-workspace-001",
      title: "Vibration Analysis in Continuous Casting Machines",
      vertical: "Steel",
      equipment: "Continuous Casters",
      pain: "Strand breakout and roller bearing seizure",
      content_type: "Case study",
      status: "Approved",
      batch_id: null,
      created_at: new Date(),
      updated_at: new Date()
    }
  ];
  const batches = [];
  const drafts = [];
  const feedback = [];
  const invitations = [];
  const stripeEvents = [];
  const subscriptions = [];
  const contentSettings = [];
  const integrations = [];
  const pageMetrics = [];
  const aiUsage = [];
  const suggestionLimits = [];
  const oauthStates = [];
  const publications = [];
  const rateLimits = new Map();
  const userSessions = new Map();

  async function query(sql, values = []) {
    const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (statement === "select 1" || statement === "begin" || statement === "commit" || statement === "rollback") {
      return { rows: [{ "?column?": 1 }] };
    }
    if (statement.startsWith("select to_regclass")) {
      return { rows: [{ name: "schema_migrations" }] };
    }
    if (statement.startsWith("select 1 from schema_migrations")) {
      return { rows: [{ "?column?": 1 }] };
    }

    // USER SESSIONS (connect-pg-simple fallback)
    if (statement.includes("user_sessions") && statement.startsWith("select")) {
      const sess = userSessions.get(values[0]);
      if (!sess) return { rows: [] };
      return { rows: [{ sess: sess.sess, expire: sess.expire }] };
    }
    if (statement.includes("user_sessions") && (statement.startsWith("insert") || statement.includes("on conflict"))) {
      const sid = values[2] || values[0];
      const sess = values[0] || values[1];
      const expire = values[1] || values[2];
      userSessions.set(sid, { sess, expire });
      return { rows: [] };
    }
    if (statement.includes("user_sessions") && statement.startsWith("update")) {
      const existing = userSessions.get(values[2]);
      if (existing) {
        existing.sess = values[0];
        existing.expire = values[1];
      } else {
        userSessions.set(values[2], { sess: values[0], expire: values[1] });
      }
      return { rows: [] };
    }
    if (statement.includes("user_sessions") && statement.startsWith("delete")) {
      userSessions.delete(values[0]);
      return { rows: [] };
    }

    // USERS
    if (statement.startsWith("insert into users")) {
      const email = values[2];
      if (users.some((u) => u.email === email)) {
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
        // In dev mock mode, verify immediately if SMTP is offline so user can log in
        email_verified_at: new Date(),
        password_reset_token_hash: null,
        password_reset_expires_at: null,
        password_changed_at: new Date(),
        auth_version: 0
      };
      users.push(user);
      return { rows: [{ id: user.id, name: user.name, email: user.email, auth_version: user.auth_version }] };
    }

    if (statement.startsWith("select id, name, email, password_hash, email_verified_at, auth_version from users where email")) {
      return { rows: users.filter((u) => u.email === values[0]) };
    }
    if (statement.startsWith("select id, name, email, email_verified_at from users where email")) {
      return { rows: users.filter((u) => u.email === values[0]) };
    }
    if (statement.startsWith("select id, name, email from users where email = $1")) {
      return { rows: users.filter((u) => u.email === values[0]).map(({ id, name, email }) => ({ id, name, email })) };
    }
    if (statement.startsWith("select id, name, email from users where id = $1")) {
      return { rows: users.filter((u) => u.id === values[0]).map(({ id, name, email }) => ({ id, name, email })) };
    }
    if (statement.startsWith("select name from users where id = $1")) {
      return { rows: users.filter((u) => u.id === values[0]).map(({ name }) => ({ name })) };
    }
    if (statement.startsWith("select email_verified_at, auth_version from users where id = $1")) {
      const u = users.find((user) => user.id === values[0]);
      return { rows: u ? [{ email_verified_at: u.email_verified_at || new Date(), auth_version: u.auth_version }] : [] };
    }
    if (statement.startsWith("update users set email_verified_at = now()")) {
      const user = users.find((u) => u.email_verification_token_hash === values[0]);
      if (user) user.email_verified_at = new Date();
      return { rows: user ? [{ id: user.id }] : [] };
    }
    if (statement.startsWith("update users set password_hash = $1")) {
      const user = users.find((u) => u.id === values[2] || u.password_reset_token_hash === values[1]);
      if (user) {
        user.password_hash = values[0];
        user.auth_version += 1;
        return { rows: [{ id: user.id, name: user.name, email: user.email }] };
      }
      return { rows: [] };
    }

    // WORKSPACES & MEMBERSHIPS
    if (statement.startsWith("insert into workspaces")) {
      const hasWebsite = statement.includes("website");
      const workspace = {
        id: values[0],
        name: values[1],
        industry: values[2],
        website: hasWebsite ? (values[3] || "") : "",
        workspace_type: "standard",
        plan: "Starter"
      };
      workspaces.push(workspace);
      return { rows: [workspace] };
    }
    if (statement.startsWith("select w.id, w.name, w.industry, w.website, w.plan")) {
      const rows = memberships
        .filter((m) => m.user_id === values[0])
        .map((m) => {
          const w = workspaces.find((item) => item.id === m.workspace_id) || workspaces[0];
          return { ...w, role: m.role };
        });
      if (!rows.length && workspaces[0]) {
        rows.push({ ...workspaces[0], role: "owner" });
      }
      return { rows };
    }
    if (statement.startsWith("select w.id, w.name, w.industry, w.website, w.workspace_type, w.plan")) {
      const rows = memberships
        .filter((m) => m.user_id === values[0])
        .map((m) => {
          const w = workspaces.find((item) => item.id === m.workspace_id) || workspaces[0];
          return { ...w, role: m.role };
        });
      if (!rows.length && workspaces[0]) {
        rows.push({ ...workspaces[0], role: "owner" });
      }
      return { rows };
    }
    if (statement.startsWith("select name from workspaces where id = $1")) {
      return { rows: workspaces.filter((w) => w.id === values[0]).map(({ name }) => ({ name })) };
    }
    if (statement.startsWith("select id from workspaces where id = $1")) {
      return { rows: workspaces.filter((w) => w.id === values[0]).map(({ id }) => ({ id })) };
    }
    if (statement.startsWith("select website from workspaces where id = $1")) {
      const w = workspaces.find((item) => item.id === values[0]);
      return { rows: w ? [{ website: w.website || "" }] : [] };
    }
    if (statement.startsWith("update workspaces set name")) {
      const w = workspaces.find((item) => item.id === values[2]);
      if (w) {
        w.name = values[0];
        w.website = values[1];
        return { rows: [{ ...w }] };
      }
      return { rows: [] };
    }
    if (statement.startsWith("insert into workspace_memberships")) {
      memberships.push({
        workspace_id: values[0],
        user_id: values[1],
        role: values[2] || (statement.includes("'owner'") ? "owner" : "editor"),
        created_at: new Date()
      });
      return { rows: [] };
    }
    if (statement.startsWith("select m.role, u.id as user_id, u.name, u.email from workspace_memberships")) {
      const m = memberships.find((item) => item.workspace_id === values[0] && item.user_id === values[1]);
      const u = users.find((item) => item.id === values[1]);
      return { rows: [{ role: m ? m.role : "owner", user_id: u ? u.id : values[1], name: u ? u.name : "Dev User", email: u ? u.email : "user@example.com" }] };
    }
    if (statement.startsWith("select 1 from workspace_memberships m join users u")) {
      return { rows: [{ "?column?": 1 }] };
    }
    if (statement.startsWith("select u.id, u.name, u.email, m.role, m.created_at")) {
      const rows = memberships
        .filter((m) => m.workspace_id === values[0])
        .map((m) => {
          const u = users.find((user) => user.id === m.user_id) || { id: m.user_id, name: "Teammate", email: "team@example.com" };
          return { id: u.id, name: u.name, email: u.email, role: m.role, created_at: m.created_at };
        });
      return { rows };
    }

    // TOPICS
    if (statement.startsWith("select count(*)::integer as total from workspace_topics")) {
      return { rows: [{ total: topics.filter((t) => t.workspace_id === values[0]).length }] };
    }
    if (statement.startsWith("select id, batch_id, title, vertical, equipment, pain, content_type, status, created_at, updated_at from workspace_topics")) {
      return { rows: topics.filter((t) => t.workspace_id === values[0]) };
    }
    if (statement.startsWith("select id, title, vertical, equipment, pain, content_type, status, created_at, updated_at from workspace_topics")) {
      return { rows: topics.filter((t) => t.workspace_id === values[0]) };
    }
    if (statement.startsWith("insert into workspace_topics")) {
      const topic = {
        id: values[0],
        workspace_id: values[1],
        title: values[2],
        vertical: values[3],
        equipment: values[4],
        pain: values[5],
        content_type: values[6],
        status: "Suggested",
        batch_id: null,
        created_at: new Date(),
        updated_at: new Date()
      };
      topics.push(topic);
      return { rows: [topic] };
    }
    if (statement.startsWith("delete from workspace_topics where id = $1 and workspace_id = $2")) {
      const idx = topics.findIndex((t) => t.id === values[0] && t.workspace_id === values[1]);
      const [removed] = idx >= 0 ? topics.splice(idx, 1) : [];
      return { rows: removed ? [{ id: removed.id }] : [] };
    }
    if (statement.startsWith("update workspace_topics set status = $1, updated_at = now() where id = $2 and workspace_id = $3")) {
      const t = topics.find((item) => item.id === values[1] && item.workspace_id === values[2]);
      if (t) {
        t.status = values[0];
        return { rows: [t] };
      }
      return { rows: [] };
    }

    // BATCHES
    if (statement.includes("from content_batches b") || statement.includes("from content_batches")) {
      const rows = batches.filter((b) => b.workspace_id === values[0]).map((b) => ({
        id: b.id,
        name: b.name,
        vertical: b.vertical,
        status: b.status,
        created_at: b.created_at,
        topic_count: b.topic_count || 0,
        draft_count: drafts.filter((d) => d.batch_id === b.id).length
      }));
      return { rows };
    }
    if (statement.startsWith("insert into content_batches")) {
      const batch = {
        id: values[0],
        workspace_id: values[1],
        name: values[2],
        vertical: values[3],
        created_by: values[4],
        status: "pending_approval",
        created_at: new Date(),
        updated_at: new Date()
      };
      batches.push(batch);
      return { rows: [batch] };
    }
    if (statement.startsWith("select id, status from content_batches where id = $1 and workspace_id = $2")) {
      const b = batches.find((item) => item.id === values[0] && item.workspace_id === values[1]);
      return { rows: b ? [{ id: b.id, status: b.status }] : [] };
    }
    if (statement.startsWith("update content_batches set status = $1")) {
      const b = batches.find((item) => item.id === values[values.length - 2] && item.workspace_id === values[values.length - 1]);
      if (b) b.status = values[0];
      return { rows: b ? [{ id: b.id, status: b.status }] : [] };
    }
    if (statement.startsWith("select t.id, t.title, t.vertical, t.equipment, t.pain, t.content_type from workspace_topics t")) {
      return { rows: topics.filter((t) => t.batch_id === values[0] && t.workspace_id === values[1]) };
    }

    // DRAFTS
    if (statement.startsWith("select count(*)::integer as total from workspace_drafts")) {
      return { rows: [{ total: drafts.filter((d) => d.workspace_id === values[0]).length }] };
    }
    if (statement.includes("from workspace_drafts where id = $1 and workspace_id = $2")) {
      const d = drafts.find((item) => item.id === values[0] && item.workspace_id === values[1]);
      return { rows: d ? [{ ...d }] : [] };
    }
    if (statement.includes("from workspace_drafts d join workspaces w on w.id = d.workspace_id")) {
      const d = drafts.find((item) => item.id === values[0] && item.workspace_id === values[1]);
      const w = workspaces.find((item) => item.id === values[1]) || workspaces[0];
      return { rows: d ? [{ ...d, workspace_name: w ? w.name : "" }] : [] };
    }
    if (statement.startsWith("select id, topic_id, title, status, version, created_by, updated_by, reviewed_by, reviewed_at, created_at, updated_at from workspace_drafts")) {
      return { rows: drafts.filter((d) => d.workspace_id === values[0]).slice(0, values[1] || 100) };
    }
    if (statement.startsWith("insert into workspace_drafts")) {
      const hasBatch = statement.includes("batch_id");
      const hasSeo = statement.includes("seo_data");
      const draft = {
        id: values[0],
        workspace_id: values[1],
        topic_id: values[2],
        title: values[3],
        body: values[4],
        status: "Draft",
        version: 1,
        created_by: values[5],
        updated_by: values[6],
        batch_id: hasBatch ? values[7] : null,
        seo_data: hasSeo ? (typeof values[8] === "string" ? JSON.parse(values[8]) : values[8]) : {},
        quality_score: 95,
        ai_repair_count: 0,
        published_url: null,
        created_at: new Date(),
        updated_at: new Date()
      };
      drafts.push(draft);
      return { rows: [draft] };
    }
    if (statement.startsWith("update workspace_drafts set title = $1, body = $2")) {
      const d = drafts.find((item) => item.id === values[3] && item.workspace_id === values[4]);
      if (d) {
        d.title = values[0];
        d.body = values[1];
        d.updated_by = values[2];
        d.version += 1;
        d.status = "Draft";
        d.updated_at = new Date();
        return { rows: [d] };
      }
      return { rows: [] };
    }
    if (statement.startsWith("update workspace_drafts set status = $1, reviewed_by = $2, reviewed_at = now()")) {
      const d = drafts.find((item) => item.id === values[2] && item.workspace_id === values[3]);
      if (d) {
        d.status = values[0];
        d.reviewed_by = values[1];
        d.reviewed_at = new Date();
        return { rows: [{ id: d.id }] };
      }
      return { rows: [] };
    }
    if (statement.startsWith("update workspace_drafts set status = 'in review'")) {
      const d = drafts.find((item) => item.id === values[0] && item.workspace_id === values[1]);
      if (d) {
        d.status = "In review";
        return { rows: [{ id: d.id }] };
      }
      return { rows: [] };
    }
    if (statement.startsWith("update workspace_drafts set seo_data = $1, quality_score = $2")) {
      const d = drafts.find((item) => item.id === values[3] && item.workspace_id === values[4]);
      if (d) {
        d.seo_data = typeof values[0] === "string" ? JSON.parse(values[0]) : values[0];
        d.quality_score = values[1];
        d.body = values[2] || d.body;
      }
      return { rows: [] };
    }

    // CONTENT SETTINGS
    if (statement.includes("from workspace_content_settings")) {
      const s = contentSettings.find((item) => item.workspace_id === values[0]);
      return {
        rows: s ? [s] : [{
          product_description: "Industrial equipment and automation solutions.",
          approved_cta: "Contact our technical sales team for engineering specifications and custom quotes.",
          minimum_word_count: 700,
          minimum_faqs: 5
        }]
      };
    }
    if (statement.startsWith("insert into workspace_content_settings")) {
      let s = contentSettings.find((item) => item.workspace_id === values[0]);
      if (!s) {
        s = { workspace_id: values[0] };
        contentSettings.push(s);
      }
      s.product_description = values[1];
      s.approved_cta = values[2];
      s.minimum_word_count = values[3];
      s.minimum_faqs = values[4];
      return { rows: [s] };
    }

    // INTEGRATIONS & ANALYTICS
    if (statement.includes("from workspace_integrations")) {
      const integ = integrations.find((item) => item.workspace_id === values[0]);
      return { rows: integ ? [integ] : [] };
    }
    if (statement.includes("from workspace_page_metrics")) {
      return {
        rows: [
          { page_path: "/solutions/chiller-diagnostics", impressions: 1420, clicks: 88, average_position: 4.2, engagement_rate: 0.65 },
          { page_path: "/guides/vibration-monitoring", impressions: 2180, clicks: 145, average_position: 3.1, engagement_rate: 0.72 }
        ]
      };
    }
    if (statement.includes("workspace_analytics")) {
      return {
        rows: [
          { page_path: "/solutions/chiller-diagnostics", impressions: 1420, clicks: 88, average_position: 4.2, engagement_rate: 0.65 },
          { page_path: "/guides/vibration-monitoring", impressions: 2180, clicks: 145, average_position: 3.1, engagement_rate: 0.72 }
        ]
      };
    }

    // AI USAGE & LIMITS
    if (statement.includes("from workspace_ai_suggestion_limits")) {
      return { rows: [{ request_count: 1 }] };
    }
    if (statement.includes("from workspace_ai_usage")) {
      return { rows: [{ used: 2 }] };
    }
    if (statement.startsWith("insert into workspace_ai_usage")) return { rows: [] };
    if (statement.startsWith("insert into workspace_ai_suggestion_limits")) return { rows: [] };
    if (statement.startsWith("insert into workspace_audit_events")) return { rows: [] };
    if (statement.startsWith("insert into draft_feedback")) return { rows: [] };

    // RATE LIMITS
    if (statement.includes("from api_rate_limits")) {
      const item = rateLimits.get(values[0]);
      return { rows: item ? [item] : [] };
    }
    if (statement.startsWith("insert into api_rate_limits")) {
      rateLimits.set(values[0], { total_hits: values[1], reset_at: values[2] });
      return { rows: [{ total_hits: values[1], reset_at: values[2] }] };
    }
    if (statement.startsWith("update api_rate_limits")) {
      const item = rateLimits.get(values[1]) || { total_hits: 0, reset_at: new Date(Date.now() + 60000) };
      item.total_hits += 1;
      return { rows: [item] };
    }

    return { rows: [] };
  }

  return {
    isMock: true,
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => {}
  };
}

module.exports = { createDevMockPool };
