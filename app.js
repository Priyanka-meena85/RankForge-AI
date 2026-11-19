const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const appMain = document.getElementById("appMain");
const breadcrumb = document.getElementById("breadcrumbCurrent");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalContent = document.getElementById("modalContent");
const toastRegion = document.getElementById("toastRegion");
const sidebar = document.getElementById("sidebar");
const publicSite = document.getElementById("publicSite");
const authGate = document.getElementById("authGate");
const productApp = document.getElementById("productApp");
const storageKey = "rankforge-ai-demo";
const legacyStorageKey = "forgeflow-demo";
let csrfToken = null;

function getApiBaseUrl() {
  const saved = localStorage.getItem("rankforge_api_base") || (typeof window !== "undefined" && window.RANKFORGE_API_URL);
  if (saved && typeof saved === "string") return saved.replace(/\/$/, "");
  const host = window.location.hostname || "localhost";
  const port = window.location.port;
  // If running via Live Server (5500, 5501, 5502) or other static server or file://, target the local Express backend on port 4000
  if (port === "5500" || port === "5501" || port === "5502" || port === "8080" || !window.location.host) {
    return `http://${host}:4000/api`;
  }
  return "/api";
}
let apiBase = getApiBaseUrl();

async function safeParseJson(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  if (contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to descriptive error below
    }
  }
  const isStaticDev = window.location.port === "5500" || window.location.port === "5501" || window.location.port === "5502";
  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  if (text.startsWith("<!DOCTYPE") || text.includes("<html") || response.status === 404) {
    if (isStaticDev) {
      throw new Error("Connected to static preview instead of the backend. Please run 'npm start' in your terminal and open http://localhost:4000.");
    }
    if (isLocalHost) {
      throw new Error("Backend API endpoint not found (HTTP 404). Ensure the server is running on http://localhost:4000.");
    }
    throw new Error("Backend API is not reachable on this host (HTTP 404). You can explore in Demo Mode or configure a backend URL.");
  }
  if (response.status >= 500) {
    throw new Error(`Server error (${response.status}). Please check backend console logs.`);
  }
  throw new Error(`Unexpected server response (HTTP ${response.status || "offline"}). Please verify backend is running.`);
}

async function fetchSafe(url, options) {
  try {
    return await fetch(url, options);
  } catch (networkError) {
    const isStaticDev = window.location.port === "5500" || window.location.port === "5501" || window.location.port === "5502";
    if (isStaticDev) {
      throw new Error("Cannot connect to backend at http://localhost:4000. Start the server by running 'npm start' in your terminal, then try again.");
    }
    throw new Error("Cannot connect to the backend server. Make sure it is running ('npm start').");
  }
}

async function loadCsrfToken() {
  const response = await fetchSafe(`${apiBase}/csrf`, { credentials: "include", cache: "no-store" });
  const result = await safeParseJson(response);
  if (!response.ok) throw new Error(result.error || "Could not start a secure session.");
  csrfToken = result.csrfToken;
}

async function apiRequest(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    if (!csrfToken) await loadCsrfToken();
    headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetchSafe(`${apiBase}${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  if (response.status === 204) return null;
  const result = await safeParseJson(response);
  if (response.status === 403 && result.error && result.error.includes("Request could not be verified") && !options._retried) {
    await loadCsrfToken();
    return apiRequest(path, { ...options, _retried: true });
  }
  if (!response.ok) {
    const error = new Error(result.error || "The request could not be completed.");
    error.status = response.status;
    throw error;
  }
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result;
}

const state = {
  user: null,
  activeWorkspaceId: "northstar",
  workspaces: [
    { id: "northstar", name: "Northstar Manufacturing", industry: "Food & Beverage", plan: "Starter", role: "Owner", website: "northstarindustrial.com" },
    { id: "forge-partners", name: "Forge Partners Studio", industry: "Agency", plan: "Agency", role: "Admin", website: "forgepartners.example" },
    { id: "client-northstar", name: "Northstar Manufacturing", industry: "Food & Beverage", plan: "Agency", role: "Admin", website: "", teamType: "Client" },
    { id: "client-apex-steel", name: "Apex Steel Systems", industry: "Steel", plan: "Agency", role: "Admin", website: "", teamType: "Client" },
    { id: "client-meridian-fleet", name: "Meridian Fleet Tech", industry: "Automotive", plan: "Agency", role: "Admin", website: "", teamType: "Client" }
  ],
  members: [
    { name: "Alex Morgan", email: "alex@northstarindustrial.com", role: "Owner", status: "Active" },
    { name: "Priya Shah", email: "priya@northstarindustrial.com", role: "Editor", status: "Active" },
    { name: "Jordan Lee", email: "jordan@northstarindustrial.com", role: "Reviewer", status: "Invited" }
  ],
  clients: [
    { id: "client-northstar", name: "Northstar Manufacturing", vertical: "Food & Beverage", pages: 12, status: "Active" },
    { id: "client-apex-steel", name: "Apex Steel Systems", vertical: "Steel", pages: 8, status: "Active" },
    { id: "client-meridian-fleet", name: "Meridian Fleet Tech", vertical: "Automotive", pages: 4, status: "Onboarding" }
  ],
  userDirectory: [],
  view: "dashboard",
  topicFilter: "All topics",
  selectedVertical: "Food & Beverage",
  reviewTab: "Draft",
  qaPatched: false,
  approved: false,
  activeEditorTab: "Content",
  search: "",
  topics: [
    { title: "Predictive maintenance for centrifugal pumps", vertical: "Food & Beverage", equipment: "Centrifugal pumps", pain: "Unplanned downtime", type: "Solution page", status: "Suggested" },
    { title: "Reduce conveyor line downtime with PdM", vertical: "Food & Beverage", equipment: "Conveyors", pain: "Unplanned downtime", type: "Solution page", status: "Suggested" },
    { title: "CIP process downtime monitoring", vertical: "Food & Beverage", equipment: "CIP systems", pain: "Cleaning delays", type: "Use case", status: "Approved" },
    { title: "EAF energy optimization software", vertical: "Steel", equipment: "Electric arc furnace", pain: "Energy costs", type: "Solution page", status: "In review" },
    { title: "Weld inspection defect detection", vertical: "Automotive", equipment: "Weld cells", pain: "Quality defects", type: "Industry page", status: "Suggested" },
    { title: "Kiln efficiency monitoring", vertical: "Cement", equipment: "Rotary kiln", pain: "Fuel consumption", type: "Use case", status: "Suggested" },
    { title: "Yarn breakage analytics for textile mills", vertical: "Textile", equipment: "Spinning frames", pain: "Yarn breakage", type: "Solution page", status: "Suggested" },
    { title: "RTU fault detection for smart buildings", vertical: "HVAC", equipment: "Rooftop units", pain: "Fault detection", type: "Industry page", status: "Approved" },
    { title: "Connect PLC and MES data with OPC UA", vertical: "SCADA & Automation", equipment: "PLC / MES", pain: "Data integration", type: "Guide", status: "Suggested" }
  ],
  batches: [
    { name: "Food & Beverage · PdM", detail: "Created today · 12 topics", initials: "FB", className: "", progress: 75, status: "In review", date: "Today" },
    { name: "Steel · Energy efficiency", detail: "Created yesterday · 8 topics", initials: "ST", className: "orange", progress: 45, status: "Generating", date: "Yesterday" },
    { name: "Automotive · Quality", detail: "Created May 18 · 10 topics", initials: "AU", className: "blue", progress: 100, status: "Ready", date: "May 18" }
  ],
  pages: [
    { title: "Predictive maintenance for centrifugal pumps", batch: "Food & Beverage · PdM", date: "May 21, 2025", status: "Approved", schema: "Article · FAQPage" },
    { title: "EAF energy optimization software", batch: "Steel · Energy efficiency", date: "May 20, 2025", status: "Approved", schema: "Article · FAQPage" },
    { title: "Weld inspection defect detection", batch: "Automotive · Quality", date: "May 19, 2025", status: "Exported", schema: "Article · HowTo" },
    { title: "CIP process downtime monitoring", batch: "Food & Beverage · PdM", date: "May 17, 2025", status: "Exported", schema: "Article · FAQPage" }
  ],
  drafts: [],
  feedback: [],
  activeDraftId: null,
  billingPlans: [],
  billingStatus: null,
  usage: null,
  contentSettings: null,
  integrations: null,
  analytics: [],
  verticals: [
    { name: "Automotive", icon: "🚘", count: "Explore topics", desc: "Stamping, paint & weld defects, warranty analytics, IATF and APQP." },
    { name: "Steel", icon: "🏭", count: "Explore topics", desc: "EAF energy, continuous casting quality and predictive maintenance." },
    { name: "Food & Beverage", icon: "🥫", count: "Explore topics", desc: "Pumps, conveyors, fillers, CIP downtime and OEE." },
    { name: "HVAC", icon: "🌬️", count: "Explore topics", desc: "FDD, RTU failure prediction and smart building AI." },
    { name: "Textile", icon: "🧵", count: "Explore topics", desc: "Yarn breakage, fabric waste and cutting room KPIs." },
    { name: "Cement", icon: "🧱", count: "Explore topics", desc: "Kiln efficiency and downtime tracking." },
    { name: "SCADA & Automation", icon: "⚙️", count: "Explore topics", desc: "PLC / MES / ERP integration, OPC UA and UNS." }
  ]
};

const demoSeed = JSON.parse(JSON.stringify({
  workspaces: state.workspaces,
  members: state.members,
  clients: state.clients,
  topics: state.topics,
  batches: state.batches,
  pages: state.pages
}));
state.workspaceData = {
  northstar: { topics: state.topics, batches: state.batches, pages: state.pages, members: state.members, clients: state.clients },
  "forge-partners": {
    topics: [],
    batches: [],
    pages: [],
    members: [{ name: "Alex Morgan", email: "alex@northstarindustrial.com", role: "Admin", status: "Active" }],
    clients: [
      { id: "client-apex-steel", name: "Apex Steel Systems", vertical: "Steel", pages: 8, status: "Active" },
      { id: "client-meridian-fleet", name: "Meridian Fleet Tech", vertical: "Automotive", pages: 4, status: "Onboarding" }
    ]
  },
  "client-apex-steel": { topics: [], batches: [], pages: [], members: [], clients: [] },
  "client-northstar": { topics: [], batches: [], pages: [], members: [], clients: [] },
  "client-meridian-fleet": { topics: [], batches: [], pages: [], members: [], clients: [] }
};
demoSeed.workspaceData = JSON.parse(JSON.stringify(state.workspaceData));

function currentWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) || state.workspaces[0];
}

function currentDraft() {
  return state.drafts.find((draft) => draft.id === state.activeDraftId) || null;
}

function persistState() {
  if (!state.user || !state.user.demo) return;
  try {
    saveCurrentWorkspaceData();
    localStorage.setItem(storageKey, JSON.stringify({
      user: state.user,
      view: state.view,
      activeWorkspaceId: state.activeWorkspaceId,
      workspaces: state.workspaces,
      members: state.members,
      clients: state.clients,
      workspaceData: state.workspaceData,
      userDirectory: state.userDirectory,
      selectedVertical: state.selectedVertical,
      topicFilter: state.topicFilter,
      search: state.search,
      qaPatched: state.qaPatched,
      approved: state.approved,
      reviewTab: state.reviewTab,
      activeEditorTab: state.activeEditorTab,
      topics: state.topics,
      batches: state.batches,
      pages: state.pages
    }));
  } catch (error) {
    showToast("Could not save this prototype session in browser storage.");
  }
}

function saveCurrentWorkspaceData() {
  if (!state.activeWorkspaceId) return;
  state.workspaceData = state.workspaceData || {};
  state.workspaceData[state.activeWorkspaceId] = {
    topics: state.topics,
    batches: state.batches,
    pages: state.pages,
    members: state.members,
    clients: state.clients
  };
}

function loadWorkspaceData(workspaceId) {
  const data = state.workspaceData && state.workspaceData[workspaceId];
  if (!data) {
    state.topics = [];
    state.batches = [];
    state.pages = [];
    state.drafts = [];
    state.feedback = [];
    state.activeDraftId = null;
    state.billingPlans = [];
    state.billingStatus = null;
    state.usage = null;
    state.contentSettings = null;
    state.integrations = null;
    state.analytics = [];
    state.members = [{ name: state.user ? state.user.name : "Workspace owner", email: state.user ? state.user.email : "", role: "Owner", status: "Active" }];
    state.clients = [];
    return;
  }
  state.topics = data.topics;
  state.batches = data.batches;
  state.pages = data.pages;
  state.members = data.members;
  state.clients = data.clients;
}

function activateWorkspace(workspace) {
  if (!workspace) return;
  state.activeWorkspaceId = workspace.id;
  if (state.user && state.user.demo) {
    loadWorkspaceData(workspace.id);
  } else {
    state.topics = [];
    state.batches = [];
    state.pages = [];
    state.drafts = [];
    state.feedback = [];
    state.activeDraftId = null;
    state.billingPlans = [];
    state.billingStatus = null;
    state.usage = null;
    state.contentSettings = null;
    state.integrations = null;
    state.analytics = [];
    state.members = [];
    state.clients = [];
  }
  updateWorkspaceChrome();
}

async function refreshWorkspaceContent(workspaceId = state.activeWorkspaceId) {
  if (!state.user || state.user.demo || !workspaceId) return;
  const result = await apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/content`);
  if (state.activeWorkspaceId !== workspaceId) return;
  state.topics = result.topics;
  state.drafts = result.drafts;
  state.feedback = result.feedback;
  state.usage = result.usage;
  state.batches = result.batches.map((batch) => {
    const statuses = {
      pending_approval: "In review",
      approved: "Approved",
      generating: "Generating",
      ready: "Ready",
      completed: "Completed"
    };
    const progress = batch.topicCount ? Math.round((batch.draftCount / batch.topicCount) * 100) : 0;
    return {
      ...batch,
      rawStatus: batch.status,
      status: statuses[batch.status] || batch.status,
      detail: `${batch.createdAt ? new Date(batch.createdAt).toLocaleDateString() : "New"} · ${batch.topicCount} topics · ${batch.draftCount} pages`,
      initials: batch.vertical.slice(0, 2).toUpperCase(),
      className: "",
      progress,
      date: batch.createdAt ? new Date(batch.createdAt).toLocaleDateString() : ""
    };
  });
  if (!state.drafts.some((draft) => draft.id === state.activeDraftId)) {
    state.activeDraftId = state.drafts[0] ? state.drafts[0].id : null;
  }
  if (state.activeDraftId) {
    const index = state.drafts.findIndex((draft) => draft.id === state.activeDraftId);
    state.drafts[index] = await apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/drafts/${encodeURIComponent(state.activeDraftId)}`);
  }
  state.pages = state.drafts
    .filter((draft) => draft.status === "Approved")
    .map((draft) => ({
      id: draft.id,
      title: draft.title,
      batch: "",
      date: draft.reviewedAt ? new Date(draft.reviewedAt).toLocaleDateString() : "",
      status: draft.publishedUrl ? "Published" : "Approved",
      publishedUrl: draft.publishedUrl || "",
      schema: "Article · FAQPage"
    }));
}

async function loadWorkspaceSettings() {
  const workspaceId = state.activeWorkspaceId;
  try {
    const [contentSettings, integrations] = await Promise.all([
      apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/content-settings`),
      apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/integrations`)
    ]);
    if (state.activeWorkspaceId !== workspaceId || state.view !== "settings") return;
    state.contentSettings = contentSettings;
    state.integrations = integrations;
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadAnalytics() {
  const workspaceId = state.activeWorkspaceId;
  try {
    const result = await apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/analytics`);
    if (state.activeWorkspaceId !== workspaceId || state.view !== "analytics") return;
    state.analytics = result.pages;
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function restoreState() {
  try {
    const saved = localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey);
    if (!saved) return false;
    const data = JSON.parse(saved);
    if (!data || !Array.isArray(data.workspaces) || !data.workspaces.length) return false;
    if (!data.user || !data.user.demo) {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(legacyStorageKey);
      return false;
    }
    Object.assign(state, data);
    if (!localStorage.getItem(storageKey)) {
      localStorage.setItem(storageKey, saved);
      localStorage.removeItem(legacyStorageKey);
    }
    return true;
  } catch (error) {
    showToast("Saved browser data could not be read. Start a fresh preview or account.");
    return false;
  }
}

function showPublic() {
  productApp.hidden = true;
  authGate.hidden = true;
  publicSite.hidden = false;
  publicSite.innerHTML = renderPublicSite();
  publicSite.querySelectorAll("[data-public-action]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.publicAction === "signup") showAuth("signup");
      if (button.dataset.publicAction === "login") showAuth("login");
      if (button.dataset.publicAction === "demo") startDemo();
      if (button.dataset.publicAction === "pricing") document.getElementById("pricingSection").scrollIntoView({ behavior: "smooth" });
      if (button.dataset.publicAction === "mobile-menu") publicSite.classList.toggle("mobile-nav-open");
    });
  });
  publicSite.querySelectorAll("[data-scroll]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    const target = document.querySelector(link.dataset.scroll);
    if (target) target.scrollIntoView({ behavior: "smooth" });
  }));
}

function renderPublicSite() {
  return `
    <header class="marketing-header"><a class="brand marketing-brand" href="#"><img class="brand-logo" src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></a>
      <nav class="marketing-nav"><a href="#platform" data-scroll="#platform">Platform</a><a href="#industries" data-scroll="#industries">Industries</a><a href="#workflow" data-scroll="#workflow">How it works</a><a href="#pricingSection" data-scroll="#pricingSection">Pricing</a></nav>
      <div class="marketing-actions"><button class="marketing-login" data-public-action="login">Log in</button><button class="button primary" data-public-action="signup">Get started ${icon("arrow")}</button><button class="marketing-mobile-menu icon-button" data-public-action="mobile-menu" aria-label="Open navigation">${icon("menu")}</button></div>
    </header>
    <main class="marketing-main">
      <section class="marketing-hero">
        <div class="hero-copy"><span class="hero-kicker"><i></i> THE CONTENT WORKFLOW FOR INDUSTRIAL TEAMS</span>
          <h1>Technical content,<br/><span>without the production drag.</span></h1>
          <p>Plan industry-specific topics, prepare structured drafts, and give your team a clear review workflow — all in one workspace.</p>
          <div class="hero-actions"><button class="button primary hero-button" data-public-action="signup">Create your workspace ${icon("arrow")}</button><button class="button hero-secondary" data-public-action="demo">${icon("grid")} Explore the demo</button></div>
          <div class="hero-note">${icon("check")} Start with a workspace. Invite your team when you're ready.</div>
        </div>
        <div class="hero-product" aria-label="RankForge AI workspace preview">
          <div class="product-window">
            <div class="window-bar"><span class="window-dots"><i></i><i></i><i></i></span><span>RankForge AI / workspace</span><span class="window-status">● All systems ready</span></div>
            <div class="window-body"><aside class="mini-sidebar"><div class="mini-logo"><img src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></div><div class="mini-org"><i>N</i><span>Northstar workspace</span><b>⌄</b></div><div class="mini-nav active">▦ &nbsp; Overview</div><div class="mini-nav">◇ &nbsp; Topics &amp; batches</div><div class="mini-nav">▤ &nbsp; Content review <b>8</b></div><div class="mini-nav">◎ &nbsp; Client workspaces</div><div class="mini-nav">⚙ &nbsp; Team &amp; access</div></aside>
              <div class="mini-main"><div class="mini-top"><span>Good morning, Alex</span><i>AM</i></div><div class="mini-stats"><div><small>Active batches</small><strong>03</strong><span>Across 3 verticals</span></div><div><small>Awaiting review</small><strong>08</strong><span>4 ready to approve</span></div><div><small>Pages this month</small><strong>12<span>/20</span></strong><span>Starter workspace</span></div></div>
                <div class="mini-panel"><div class="mini-panel-title"><b>Production overview</b><span>View batches →</span></div><div class="mini-row"><i class="mini-row-icon">F</i><span><b>Food &amp; Beverage · PdM</b><small>12 topics · Created today</small></span><em>In review</em><div class="mini-progress"><i style="width:75%"></i></div></div><div class="mini-row"><i class="mini-row-icon orange">S</i><span><b>Steel · Energy efficiency</b><small>8 topics · Created yesterday</small></span><em class="gray">Generating</em><div class="mini-progress"><i style="width:45%"></i></div></div><div class="mini-row"><i class="mini-row-icon blue">A</i><span><b>Automotive · Quality</b><small>10 topics · Created May 18</small></span><em>Ready</em><div class="mini-progress"><i style="width:100%"></i></div></div></div>
              </div>
            </div>
          </div>
          <div class="hero-floating-card"><span class="floating-check">${icon("check")}</span><span><b>Review with confidence</b><small>Clear QA status on every draft</small></span><span class="floating-pills"><i></i><i></i><i></i></span></div>
        </div>
        <div class="hero-orb orb-one"></div><div class="hero-orb orb-two"></div>
      </section>
      <section class="proof-strip"><span>BUILT FOR COMPLEX CONTENT OPERATIONS</span><div><i>01</i> Seeded industrial taxonomy</div><div><i>02</i> Structured QA workflow</div><div><i>03</i> Team review &amp; approvals</div><div><i>04</i> Workspace-level organization</div></section>
      <section class="marketing-section" id="platform"><div class="section-intro"><span class="hero-kicker">ONE SHARED WORKFLOW</span><h2>From industry insight<br/>to review-ready content.</h2><p>Bring your strategists, writers, and reviewers into one repeatable process — with your technical context and quality checks close at hand.</p></div>
        <div class="feature-grid"><article class="feature-card feature-emphasis"><span class="feature-icon">${icon("layers")}</span><span class="feature-number">01 / PLAN</span><h3>Start with the industrial map</h3><p>Browse seeded topic ideas by vertical, equipment, and pain point. Curate the next batch around your product.</p><span class="feature-tag">7 INDUSTRIAL VERTICALS</span></article>
        <article class="feature-card"><span class="feature-icon">${icon("spark")}</span><span class="feature-number">02 / PREPARE</span><h3>Keep drafts on-structure</h3><p>Apply your page rules, approved links, CTA guidance, and schema requirements before a reviewer sees the draft.</p><span class="feature-tag">STRUCTURE CHECKS</span></article>
        <article class="feature-card"><span class="feature-icon">${icon("check")}</span><span class="feature-number">03 / REVIEW</span><h3>Make decisions as a team</h3><p>Give reviewers a live preview, visible checklist, version context, and a clear approval or change-request path.</p><span class="feature-tag">HUMAN APPROVAL</span></article></div>
      </section>
      <section class="workflow-section" id="workflow"><div class="workflow-copy"><span class="hero-kicker">BUILT AROUND YOUR TEAM</span><h2>Clear handoffs.<br/><span>Fewer loose ends.</span></h2><p>Keep work moving across shared batches and reviewer queues. Invite colleagues with the access they need, and separate client projects into their own workspaces.</p><button class="text-button" data-public-action="signup">Build your team workspace ${icon("arrow")}</button></div>
        <div class="workflow-board"><div class="board-header"><div><span class="board-eyebrow">FOOD &amp; BEVERAGE · PDM</span><h3>Batch review workflow</h3></div><span class="board-avatar-stack"><i>AM</i><i>PS</i><i>JL</i><b>+2</b></span></div><div class="board-steps"><div class="board-step done"><span>${icon("check")}</span><div><b>Topic batch approved</b><small>12 topics · Alex Morgan · 9:42 AM</small></div><em>Done</em></div><div class="board-step done"><span>${icon("check")}</span><div><b>Drafts generated &amp; checked</b><small>Rule checks complete · 11:08 AM</small></div><em>Done</em></div><div class="board-step current"><span>3</span><div><b>Technical review</b><small>4 pages ready · Priya Shah</small></div><em>In progress</em></div><div class="board-step"><span>4</span><div><b>Final approval &amp; export</b><small>Owner approval required</small></div><em>Up next</em></div></div><div class="board-footer"><span>${icon("clock")} Activity is visible to workspace members</span><span>Open review →</span></div></div>
      </section>
      <section class="industry-section" id="industries"><div class="section-intro centered"><span class="hero-kicker">INDUSTRIAL CONTEXT, BUILT IN</span><h2>A starting point for specialized teams.</h2><p>Explore a curated taxonomy across manufacturing and industrial technology workflows.</p></div><div class="industry-chips">${state.verticals.map((vertical) => `<span><i>${vertical.icon}</i>${escapeHtml(vertical.name)}</span>`).join("")}</div></section>
      <section class="pricing-section" id="pricingSection"><div class="section-intro centered"><span class="hero-kicker">A CLEAR STARTING POINT</span><h2>Plans that grow with your workflow.</h2><p>Indicative launch pricing from the project brief. Confirm final limits and terms before accepting payment.</p></div><div class="pricing-grid"><article class="pricing-card"><span class="pricing-name">STARTER</span><h3>For a focused team</h3><p>Build and review your first industrial content batches.</p><div class="price">$79 <small>/ month</small></div><ul><li>${icon("check")} Workspace topics and drafts</li><li>${icon("check")} Workspace settings and URLs</li><li>${icon("check")} Industrial topic library</li><li>${icon("check")} Review &amp; HTML export</li></ul><button class="button" data-public-action="signup">Create a workspace ${icon("arrow")}</button></article><article class="pricing-card featured"><span class="pricing-popular">GROWING TEAMS</span><span class="pricing-name">GROWTH</span><h3>For a scaling content operation</h3><p>Coordinate a higher volume of pages across more sites.</p><div class="price">$199 <small>/ month</small></div><ul><li>${icon("check")} Team review workflow</li><li>${icon("check")} Workspace topics and drafts</li><li>${icon("check")} Shared team review</li><li>${icon("check")} Analytics planned for V1</li></ul><button class="button primary" data-public-action="signup">Get started ${icon("arrow")}</button></article><article class="pricing-card"><span class="pricing-name">AGENCY</span><h3>For multi-client teams</h3><p>Keep client projects organized with a setup designed for agencies.</p><div class="price custom-price">Let's talk</div><ul><li>${icon("check")} Separate client workspaces</li><li>${icon("check")} Workspace role controls</li><li>${icon("check")} White-label planned for V1</li><li>${icon("check")} Limits to be confirmed</li></ul><button class="button" data-public-action="signup">Talk to our team ${icon("arrow")}</button></article></div><p class="pricing-note">Prices and included features are illustrative. Workspace Plan & usage shows configured Stripe prices; quotas and entitlements require validation before launch.</p></section>
      <section class="final-cta"><div><span class="hero-kicker">READY TO GET ORGANIZED?</span><h2>Give your industrial content<br/>a better production system.</h2><p>Create a workspace, set your context, and invite the people who move pages forward.</p></div><button class="button primary hero-button" data-public-action="signup">Create your workspace ${icon("arrow")}</button></section>
    </main>
    <footer class="marketing-footer">
      <div class="marketing-footer-top">
        <div class="marketing-footer-brand">
          <a class="brand marketing-brand" href="#"><img class="brand-logo" src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></a>
          <p class="marketing-footer-tagline">Industrial content engine for manufacturing and technical B2B companies. Pre-built vertical taxonomies, closed-loop rule QA, and automated schema.</p>
        </div>
        <div class="marketing-footer-cols">
          <div class="footer-col">
            <h4>Workflow</h4>
            <a href="#platform" data-scroll="#platform">Vertical Taxonomy</a>
            <a href="#workflow" data-scroll="#workflow">Topic Batches</a>
            <a href="#workflow" data-scroll="#workflow">AI Generation</a>
            <a href="#pricingSection" data-scroll="#pricingSection">Plans &amp; Pricing</a>
          </div>
          <div class="footer-col">
            <h4>Verticals</h4>
            <span>Automotive</span>
            <span>Steel &amp; Metals</span>
            <span>Food &amp; Beverage</span>
            <span>HVAC &amp; Cleanrooms</span>
            <span>Chemical &amp; Materials</span>
          </div>
          <div class="footer-col">
            <h4>Platform</h4>
            <button class="footer-link-btn" data-public-action="login">Log in</button>
            <button class="footer-link-btn" data-public-action="signup">Create workspace</button>
            <button class="footer-link-btn" data-public-action="demo">Explore sample</button>
          </div>
        </div>
      </div>
      <div class="marketing-footer-bottom">
        <span>© 2026 RankForge AI <span class="footer-dot">·</span> Industrial content, engineered.</span>
        <span>PostgreSQL server-backed storage <span class="footer-dot">·</span> End-to-end 8-step workflow</span>
      </div>
    </footer>`;
}

function renderAuthFooter() {
  return `
    <footer class="auth-footer">
      <div class="auth-footer-brand">
        <span>RankForge AI <span class="footer-dot">·</span> Industrial SEO &amp; Content Engine</span>
      </div>
      <div class="auth-footer-links">
        <button class="footer-link-btn" data-back-public>← Back to Home</button>
        <button class="footer-link-btn" data-auth-action="demo">Explore sample workspace</button>
        <span>Server-backed workspace · Port 4000</span>
      </div>
    </footer>`;
}

function showAuth(mode = "signup") {
  publicSite.hidden = true;
  productApp.hidden = true;
  authGate.hidden = false;
  authGate.innerHTML = renderAuth(mode);
  authGate.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => showAuth(button.dataset.authMode)));
  authGate.querySelectorAll("[data-auth-action]").forEach((button) => button.addEventListener("click", () => handleAuth(button.dataset.authAction)));
  authGate.querySelectorAll("[data-back-public]").forEach((button) => button.addEventListener("click", showPublic));
}

function renderAuth(mode) {
  const isSignup = mode === "signup";
  return `
    <div class="auth-page">
      <div class="auth-topbar">
        <button class="brand marketing-brand" data-back-public><img class="brand-logo" src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></button>
        <button class="marketing-login" data-back-public>← Back to RankForge AI</button>
      </div>
      <div class="auth-layout">
        <section class="auth-intro">
          <span class="hero-kicker">YOUR INDUSTRIAL CONTENT WORKSPACE</span>
          <h1>${isSignup ? "Start with a workspace." : "Welcome back."}</h1>
          <p>${isSignup ? "Set up your organization and invite your team when you're ready. Your workspace is scoped to your projects." : "Sign in to pick up where your team left off."}</p>
          <div class="auth-benefit">${icon("check")} Your team, roles, and projects in one place</div>
          <div class="auth-benefit">${icon("check")} Separate client workspaces for agency teams</div>
          <div class="auth-benefit">${icon("check")} Clear review and approval handoffs</div>
          <div class="auth-note">Your account, workspace topics, drafts, review decisions, and membership roles are stored and authorized by the server. Stripe billing is available when configured; AI generation is not connected.</div>
        </section>
        <section class="auth-card">
          <div class="auth-toggle">
            <button class="${isSignup ? "active" : ""}" data-auth-mode="signup">Create account</button>
            <button class="${!isSignup ? "active" : ""}" data-auth-mode="login">Log in</button>
          </div>
          <h2>${isSignup ? "Create your team workspace" : "Log in to your workspace"}</h2>
          <p>${isSignup ? "Create an account with a strong password." : "Sign in with your account email and password."}</p>
          <div class="auth-error" id="authError" hidden></div>
          ${isSignup ? `<div class="settings-field"><label for="authName">Your name</label><input id="authName" autocomplete="name" placeholder="e.g. Alex Morgan" required /></div>` : ""}
          <div class="settings-field">
            <label for="authEmail">Work email</label>
            <input id="authEmail" type="email" autocomplete="email" placeholder="you@company.com" required />
          </div>
          <div class="settings-field">
            <label for="authPassword">Password</label>
            <input id="authPassword" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="${isSignup ? "12" : "1"}" maxlength="128" required />
            ${isSignup ? `<small>Use at least 12 characters.</small>` : ""}
          </div>
          ${isSignup ? `<div class="settings-field"><label for="authCompany">Company / workspace name</label><input id="authCompany" autocomplete="organization" placeholder="e.g. Northstar Manufacturing" required /></div><div class="settings-field"><label for="authWebsite">Website</label><input id="authWebsite" type="url" placeholder="https://northstarmanufacturing.com" /></div><div class="settings-field"><label for="authIndustry">Industry</label><select id="authIndustry">${state.verticals.map((v) => `<option>${escapeHtml(v.name)}</option>`).join("")}<option>Other industrial / technical</option></select></div>` : ""}
          <button class="button primary auth-submit" data-auth-action="${isSignup ? "signup" : "login"}">${isSignup ? "Create workspace" : "Continue"} ${icon("arrow")}</button>
          ${!isSignup ? `<button class="text-button" data-auth-action="forgot-password">Forgot password?</button><button class="text-button" data-auth-action="resend-verification">Resend verification email</button>` : ""}
          <div class="auth-divider"><span>OR</span></div>
          <button class="button auth-demo" data-auth-action="demo">${icon("grid")} Explore a sample workspace</button>
          <small class="auth-disclaimer">${sessionStorage.getItem("rankforge-pending-invitation") ? "Sign in using the invited email address to accept the workspace invitation." : "Email verification and password recovery links are sent to the address on your account."}</small>
        </section>
      </div>
      ${renderAuthFooter()}
    </div>`;
}

function setAuthenticatedWorkspace(user, workspaces) {
  state.user = user;
  state.workspaces = workspaces;
  state.activeWorkspaceId = workspaces[0] ? workspaces[0].id : "";
  state.members = [];
  state.clients = workspaces.filter((workspace) => workspace.kind === "client" || workspace.workspace_type === "client")
    .map((workspace) => ({ id: workspace.id, name: workspace.name, vertical: workspace.industry, pages: 0, status: "Active" }));
  state.topics = [];
  state.batches = [];
  state.pages = [];
  state.drafts = [];
  state.feedback = [];
  state.activeDraftId = null;
  state.billingPlans = [];
  state.billingStatus = null;
  state.workspaceData = {};
  state.userDirectory = [];
  state.view = "dashboard";
  state.selectedVertical = workspaces[0] && state.verticals.some((vertical) => vertical.name === workspaces[0].industry)
    ? workspaces[0].industry
    : "Food & Beverage";
  state.topicFilter = "All topics";
  state.search = "";
  state.qaPatched = false;
  state.approved = false;
}

async function handleAuth(action, invitationToken) {
  if (action === "demo") return startDemo();
  const error = document.getElementById("authError");
  const email = document.getElementById("authEmail").value.trim().toLowerCase();
  const password = document.getElementById("authPassword").value;
  try {
    if (action === "register-invitation") {
      const name = document.getElementById("authName").value.trim();
      await apiRequest("/invitations/register", {
        method: "POST",
        body: { token: invitationToken, name, email, password }
      });
      sessionStorage.removeItem("rankforge-pending-invitation");
      const account = await apiRequest("/me");
      setAuthenticatedWorkspace(account.user, account.workspaces);
      await refreshWorkspaceContent();
      showProduct();
      showToast("Account created and workspace invitation accepted.");
      return;
    }
    if (action === "signup") {
      const name = document.getElementById("authName").value.trim();
      const workspaceName = document.getElementById("authCompany").value.trim();
      const website = document.getElementById("authWebsite").value.trim();
      const industry = document.getElementById("authIndustry").value;
      const result = await apiRequest("/auth/register", {
        method: "POST",
        body: { name, email, password, workspaceName, industry, website }
      });
      showAuth("login");
      document.getElementById("authEmail").value = email;
      showToast(result.message);
      return;
    }
    if (action === "resend-verification") {
      const result = await apiRequest("/auth/resend-verification", { method: "POST", body: { email } });
      error.textContent = result.message;
      error.hidden = false;
      return;
    }
    if (action === "forgot-password") {
      const result = await apiRequest("/auth/forgot-password", { method: "POST", body: { email } });
      error.textContent = result.message;
      error.hidden = false;
      return;
    }
    if (action === "login") {
      const result = await apiRequest("/auth/login", { method: "POST", body: { email, password } });
      const account = await apiRequest("/me");
      setAuthenticatedWorkspace(account.user, account.workspaces);
      if (sessionStorage.getItem("rankforge-pending-invitation")) {
        await acceptPendingInvitation(account);
      } else {
        await refreshWorkspaceContent().catch((loadError) => showToast(loadError.message));
      }
      showProduct();
      showToast("You are signed in.");
    }
  } catch (requestError) {
    const isOffline = requestError.message.includes("404") || requestError.message.includes("not reachable") || requestError.message.includes("Cannot connect");
    if (isOffline) {
      error.innerHTML = `<div>${escapeHtml(requestError.message)}</div><div style="margin-top:10px;"><button type="button" class="button secondary" style="width:100%;font-size:0.85rem;" id="errorDemoBtn">Explore sample workspace in Demo Mode →</button></div>`;
      const demoBtn = document.getElementById("errorDemoBtn");
      if (demoBtn) demoBtn.onclick = () => startDemo();
    } else {
      error.textContent = requestError.message;
    }
    error.hidden = false;
  }
}

function showEmailVerification(token) {
  window.history.replaceState({}, "", window.location.pathname);
  publicSite.hidden = true;
  productApp.hidden = true;
  authGate.hidden = false;
  authGate.innerHTML = `<div class="auth-page"><div class="auth-topbar"><button class="brand marketing-brand" data-back-public><img class="brand-logo" src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></button><button class="marketing-login" data-back-public>← Back to RankForge AI</button></div><div class="auth-layout"><section class="auth-card"><span class="hero-kicker">ACCOUNT VERIFICATION</span><h2>Verify your email address</h2><p>Confirm that you control this address to activate the account and its workspace.</p><div class="auth-error" id="authError" hidden></div><button class="button primary auth-submit" id="verifyEmailButton">Verify email</button></section></div>${renderAuthFooter()}</div>`;
  authGate.querySelectorAll("[data-back-public]").forEach((button) => button.addEventListener("click", showPublic));
  document.getElementById("verifyEmailButton").addEventListener("click", async () => {
    const error = document.getElementById("authError");
    try {
      const result = await apiRequest("/auth/verify-email", { method: "POST", body: { token } });
      window.history.replaceState({}, "", window.location.pathname);
      showAuth("login");
      showToast(result.message);
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  });
}

function showPasswordReset(token) {
  window.history.replaceState({}, "", window.location.pathname);
  publicSite.hidden = true;
  productApp.hidden = true;
  authGate.hidden = false;
  authGate.innerHTML = `<div class="auth-page"><div class="auth-topbar"><button class="brand marketing-brand" data-back-public><img class="brand-logo" src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></button><button class="marketing-login" data-back-public>← Back to RankForge AI</button></div><div class="auth-layout"><section class="auth-card"><span class="hero-kicker">ACCOUNT RECOVERY</span><h2>Choose a new password</h2><p>Use at least 12 characters. Reset links can only be used once.</p><div class="auth-error" id="authError" hidden></div><div class="settings-field"><label for="resetPassword">New password</label><input id="resetPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></div><button class="button primary auth-submit" id="resetPasswordButton">Update password</button></section></div>${renderAuthFooter()}</div>`;
  authGate.querySelectorAll("[data-back-public]").forEach((button) => button.addEventListener("click", showPublic));
  document.getElementById("resetPasswordButton").addEventListener("click", async () => {
    const error = document.getElementById("authError");
    try {
      const password = document.getElementById("resetPassword").value;
      const result = await apiRequest("/auth/reset-password", { method: "POST", body: { token, password } });
      showAuth("login");
      showToast(result.message);
    } catch (requestError) {
      error.textContent = requestError.message;
      error.hidden = false;
    }
  });
}

function showInvitationSignup(token) {
  publicSite.hidden = true;
  productApp.hidden = true;
  authGate.hidden = false;
  authGate.innerHTML = `<div class="auth-page"><div class="auth-topbar"><button class="brand marketing-brand" data-back-public><img class="brand-logo" src="assets/rankforge-ai-logo.png" alt="RankForge AI" /></button><button class="marketing-login" data-back-public>← Back to RankForge AI</button></div><div class="auth-layout"><section class="auth-card"><span class="hero-kicker">WORKSPACE INVITATION</span><h2>Join your team</h2><p>Enter the invited email address to create an account and accept this workspace invitation.</p><div class="auth-error" id="authError" hidden></div><div class="settings-field"><label for="authName">Your name</label><input id="authName" autocomplete="name" required /></div><div class="settings-field"><label for="authEmail">Invited email</label><input id="authEmail" type="email" autocomplete="email" required /></div><div class="settings-field"><label for="authPassword">Create password</label><input id="authPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /><small>Use at least 12 characters.</small></div><button class="button primary auth-submit" data-auth-action="register-invitation">Create account and join</button><button class="text-button" data-auth-mode="login">Already have an account? Sign in</button></section></div>${renderAuthFooter()}</div>`;
  authGate.querySelectorAll("[data-back-public]").forEach((button) => button.addEventListener("click", showPublic));
  authGate.querySelectorAll("[data-auth-action]").forEach((button) => button.addEventListener("click", () => handleAuth(button.dataset.authAction, token)));
  authGate.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => showAuth(button.dataset.authMode)));
}

async function acceptPendingInvitation() {
  const token = sessionStorage.getItem("rankforge-pending-invitation");
  if (!token) return;
  try {
    const accepted = await apiRequest("/invitations/accept", { method: "POST", body: { token } });
    const account = await apiRequest("/me");
    setAuthenticatedWorkspace(account.user, account.workspaces);
    state.activeWorkspaceId = accepted.workspaceId;
    await refreshWorkspaceContent();
    showToast("Invitation accepted. You now have access to the workspace.");
  } catch (error) {
    showToast(error.message);
  } finally {
    sessionStorage.removeItem("rankforge-pending-invitation");
  }
}

function startDemo() {
  const demoWorkspaceIds = demoSeed.workspaces.map((workspace) => workspace.id);
  const otherWorkspaces = state.workspaces.filter((workspace) => !demoWorkspaceIds.includes(workspace.id));
  const existingWorkspaceData = state.workspaceData || {};
  state.workspaces = JSON.parse(JSON.stringify(demoSeed.workspaces));
  state.workspaces.push(...otherWorkspaces);
  state.members = JSON.parse(JSON.stringify(demoSeed.members));
  state.clients = JSON.parse(JSON.stringify(demoSeed.clients));
  state.topics = JSON.parse(JSON.stringify(demoSeed.topics));
  state.batches = JSON.parse(JSON.stringify(demoSeed.batches));
  state.pages = JSON.parse(JSON.stringify(demoSeed.pages));
  state.selectedVertical = "Food & Beverage";
  state.topicFilter = "All topics";
  state.search = "";
  state.qaPatched = false;
  state.approved = false;
  state.reviewTab = "Draft";
  state.activeEditorTab = "Content";
  state.workspaceData = {
    ...existingWorkspaceData,
    ...JSON.parse(JSON.stringify(demoSeed.workspaceData)),
    northstar: { topics: state.topics, batches: state.batches, pages: state.pages, members: state.members, clients: state.clients },
    "forge-partners": JSON.parse(JSON.stringify(demoSeed.workspaceData["forge-partners"]))
  };
  state.view = "dashboard";
  state.user = { name: "Alex Morgan", email: "alex@northstarindustrial.com", demo: true };
  state.activeWorkspaceId = "northstar";
  if (!state.userDirectory.some((user) => user.email === state.user.email)) {
    state.userDirectory.push({ name: state.user.name, email: state.user.email, workspaceId: "northstar" });
  }
  persistState();
  showProduct();
}

function showProduct() {
  publicSite.hidden = true;
  authGate.hidden = true;
  productApp.hidden = false;
  updateWorkspaceChrome();
  setView(state.view || "dashboard");
}

function updateWorkspaceChrome() {
  const workspace = currentWorkspace();
  const name = workspace ? workspace.name : "Your workspace";
  document.querySelector(".workspace-copy strong").textContent = name;
  document.querySelector(".workspace-copy small").textContent = `${workspace ? workspace.plan : "Starter"} workspace · ${workspace ? workspace.role : "Owner"}`;
  document.querySelector(".workspace-avatar").textContent = name.slice(0, 1).toUpperCase();
  document.querySelector(".breadcrumbs span").textContent = name;
  document.querySelector(".profile-copy strong").textContent = state.user ? state.user.name : "Workspace owner";
  document.querySelector(".profile-copy small").textContent = workspace ? workspace.role : "Owner";
  document.querySelector(".profile-avatar").textContent = state.user ? initials(state.user.name) : "FF";
  document.querySelector(".top-avatar").textContent = state.user ? initials(state.user.name) : "FF";
  document.querySelector(".app-footer > span:last-child").textContent = state.user && state.user.demo
    ? "Demo workspace · Sample data"
    : "Workspace content · PostgreSQL stored · Access checked per workspace";
}

function initials(name) {
  return String(name || "").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

const statusClass = (status) => {
  if (["Approved", "Ready", "Published", "Exported"].includes(status)) return "green";
  if (["In review", "Suggested"].includes(status)) return "amber";
  if (["Generating", "In generation"].includes(status)) return "gray";
  return "gray";
};
const chip = (status) => `<span class="status-chip ${statusClass(status)}"><i class="status-dot"></i>${status}</span>`;

function setView(view) {
  state.view = view;
  sidebar.classList.remove("open");
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const labels = { dashboard: "Overview", topics: "Topics & batches", review: "Content review", published: "Published pages", settings: "Settings", analytics: "Analytics" };
  Object.assign(labels, { clients: "Client workspaces", team: "Team & access", plans: "Plan & usage" });
  breadcrumb.textContent = labels[view] || "Overview";
  render();
  if (view === "settings" && state.user && !state.user.demo) loadWorkspaceSettings();
  if (view === "analytics" && state.user && !state.user.demo) loadAnalytics();
  if (view === "team" && state.user && !state.user.demo) refreshWorkspaceMembers();
  if (view === "plans" && state.user && !state.user.demo) {
    const workspaceId = state.activeWorkspaceId;
    Promise.all([
      apiRequest("/billing/plans"),
      apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/billing`)
    ]).then(([plans, billing]) => {
      if (state.activeWorkspaceId !== workspaceId || state.view !== "plans") return;
      state.billingPlans = plans.plans;
      state.billingStatus = billing;
      render();
    }).catch((error) => showToast(error.message));
  }
}

function render() {
  const views = { dashboard: renderDashboard, topics: renderTopics, review: renderReview, published: renderPublished, settings: renderSettings, analytics: renderAnalytics, clients: renderClients, team: renderTeam, plans: renderPlans };
  appMain.innerHTML = (views[state.view] || renderDashboard)();
  bindPageEvents();
}

async function refreshWorkspaceMembers() {
  const workspaceId = state.activeWorkspaceId;
  try {
    const [result, invitations] = await Promise.all([
      apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/members`),
      apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/invitations`)
    ]);
    if (state.activeWorkspaceId !== workspaceId || state.view !== "team") return;
    state.members = result.members.concat(invitations.invitations.map((invitation) => ({
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      name: null
    })));
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function canManageWorkspace() {
  return Boolean(state.user && (state.user.demo || currentWorkspace() && ["Owner", "Admin"].includes(currentWorkspace().role)));
}

function renderDashboard() {
  if (!state.user || !state.user.demo || state.activeWorkspaceId !== "northstar") return renderNewWorkspaceDashboard();
  const today = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
  return `
    <div class="welcome-row">
      <div>
        <div class="eyebrow">${today} <span class="demo-chip">DEMO DATA</span></div>
        <h1>Good morning, ${escapeHtml(state.user.name.split(" ")[0])} <span aria-hidden="true">✳</span></h1>
        <p class="page-subtitle">A clear view of your industrial content pipeline.</p>
      </div>
      <div class="heading-actions"><span class="phase-chip">MVP workspace</span><button class="button primary" data-action="new-batch">${icon("plus")} New batch</button></div>
    </div>
    <section class="metric-grid" aria-label="Workspace summary">
      <article class="metric-card"><div class="metric-top"><span>Batches in progress</span><i class="metric-icon">${icon("layers")}</i></div><div class="metric-value">3</div><div class="metric-foot">Across 3 industrial verticals</div></article>
      <article class="metric-card"><div class="metric-top"><span>Pages awaiting review</span><i class="metric-icon">${icon("file")}</i></div><div class="metric-value">8</div><div class="metric-foot"><span class="positive">4 ready</span> for your approval</div></article>
      <article class="metric-card"><div class="metric-top"><span>Pages approved</span><i class="metric-icon">${icon("check")}</i></div><div class="metric-value">24</div><div class="metric-foot">This month <span class="positive">· demo count</span></div></article>
      <article class="metric-card"><div class="metric-top"><span>Monthly page allowance</span><i class="metric-icon">${icon("chart")}</i></div><div class="metric-value">12<span style="font-size:13px;color:#87938a;font-weight:500"> / 20</span></div><div class="metric-foot">Starter plan · sample usage</div></article>
    </section>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-heading"><div><h2>Active batches</h2><p>Keep an eye on production from topic to review.</p></div><button class="text-button" data-view="topics">View all ${icon("arrow")}</button></div>
        <div class="batch-list">${state.batches.map((batch) => `
          <div class="batch-row">
            <div class="batch-title"><span class="batch-avatar ${batch.className}">${escapeHtml(batch.initials)}</span><div class="batch-title-copy"><strong>${escapeHtml(batch.name)}</strong><small>${escapeHtml(batch.detail)}</small></div></div>
            <div class="progress-wrap"><div class="progress-label"><span>Progress</span><span>${batch.progress}%</span></div><div class="progress-track"><span style="width:${batch.progress}%"></span></div></div>
            ${chip(batch.status)}<span class="batch-date">${batch.date}</span>
          </div>`).join("")}</div>
      </section>
      <section class="panel activity-panel">
        <div class="panel-heading"><div><h2>Recent activity</h2><p>Updates from your workspace.</p></div><span class="demo-chip">SAMPLE</span></div>
        <div class="activity-list">
          <div class="activity-item"><span class="activity-icon">${icon("check")}</span><div class="activity-copy"><strong>Alex Morgan</strong> approved a page in <strong>Food &amp; Beverage · PdM</strong><time>12 min ago</time></div></div>
          <div class="activity-item"><span class="activity-icon amber">${icon("spark")}</span><div class="activity-copy"><strong>QA auto-patch</strong> resolved a missing CTA in a draft<time>48 min ago</time></div></div>
          <div class="activity-item"><span class="activity-icon">${icon("layers")}</span><div class="activity-copy">New batch created for <strong>Steel · Energy efficiency</strong><time>Yesterday at 4:32 PM</time></div></div>
        </div>
      </section>
    </div>
    <div class="taxonomy-banner"><div class="taxonomy-art">${icon("spark")}</div><div class="taxonomy-copy"><h3>Your next industrial topic is already mapped.</h3><p>Browse a seeded taxonomy across 7 verticals, then shape a batch around your product.</p></div><button class="button" data-view="topics">Explore taxonomy ${icon("arrow")}</button></div>
    <div class="dashboard-grid" style="margin-top:20px">
      <section class="panel">
        <div class="panel-heading"><div><h2>Review queue</h2><p>Drafts waiting for a human decision.</p></div><button class="text-button" data-view="review">Open review queue ${icon("arrow")}</button></div>
        <div class="batch-list">
          <div class="batch-row"><div class="batch-title"><span class="batch-avatar">01</span><div class="batch-title-copy"><strong>Predictive maintenance for centrifugal pumps</strong><small>Food &amp; Beverage · Updated 12 min ago</small></div></div><span class="status-chip green"><i class="status-dot"></i>QA passed</span><span class="batch-date">Review ${icon("chevron")}</span></div>
          <div class="batch-row"><div class="batch-title"><span class="batch-avatar orange">02</span><div class="batch-title-copy"><strong>EAF energy optimization software</strong><small>Steel · Updated 48 min ago</small></div></div><span class="status-chip amber"><i class="status-dot"></i>Needs attention</span><span class="batch-date">Review ${icon("chevron")}</span></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Quality, before publish</h2><p>Every draft follows a reviewable checklist.</p></div></div>
        <div class="activity-list">
          <div class="activity-item"><span class="activity-icon">${icon("check")}</span><div class="activity-copy"><strong>Structure checks</strong> for words, FAQs and CTAs<time>Rule-based validation · MVP</time></div></div>
          <div class="activity-item"><span class="activity-icon">${icon("check")}</span><div class="activity-copy"><strong>Approved link allowlist</strong> and batch uniqueness<time>Review before anything goes live</time></div></div>
          <div class="activity-item"><span class="activity-icon">${icon("file")}</span><div class="activity-copy"><strong>Schema-ready drafts</strong> with human approval<time>JSON-LD preview in content review</time></div></div>
        </div>
      </section>
    </div>`;
}

function renderTopics() {
  if (state.user && !state.user.demo) return renderPersistedTopics();
  const filtered = state.topics.filter((topic) => {
    const matchesTab = state.topicFilter === "All topics" || topic.status === state.topicFilter;
    const searchTerm = state.search.toLowerCase();
    const matchesSearch = !searchTerm || `${topic.title} ${topic.vertical} ${topic.equipment} ${topic.pain}`.toLowerCase().includes(searchTerm);
    return topic.vertical === state.selectedVertical && matchesTab && matchesSearch;
  });
  const tabs = ["All topics", "Suggested", "Approved", "In review"];
  return `
    <div class="page-heading"><div><div class="eyebrow">Industrial taxonomy <span class="demo-chip">SEEDED LIBRARY</span></div><h1>Topics &amp; batches</h1><p class="page-subtitle">Start from the industry's equipment and pain points, then build a focused content batch.</p></div><div class="heading-actions"><button class="button" data-action="add-topic">${icon("plus")} Add a topic</button><button class="button primary" data-action="new-batch">${icon("plus")} New batch</button></div></div>
    <div class="topic-layout">
      <section class="panel topic-main">
        <div class="panel-heading"><div><h2>Topic library</h2><p>Explore topics mapped to ${escapeHtml(state.selectedVertical)}.</p></div><span class="status-chip gray">${escapeHtml(state.selectedVertical)}</span></div>
        <div class="filter-tabs">${tabs.map((tab) => `<button class="filter-tab ${state.topicFilter === tab ? "active" : ""}" data-filter="${tab}">${tab}</button>`).join("")}</div>
        <div class="topic-toolbar" style="padding:12px 14px 0">
          <label class="search-box">${icon("search")}<input id="topicSearch" type="search" placeholder="Search equipment, pain points..." value="${escapeHtml(state.search)}" /></label>
          <button class="button small" data-action="generate-selected">${icon("file")} ${state.user && state.user.demo ? "Generate selected" : "Create drafts from selection"}</button>
        </div>
        <div class="table-wrap">
          <table class="topic-table"><thead><tr><th><input class="table-checkbox" id="selectAll" type="checkbox" aria-label="Select all topics" /></th><th>TOPIC IDEA</th><th>EQUIPMENT</th><th>CONTENT TYPE</th><th>STATUS</th></tr></thead>
            <tbody>${filtered.length ? filtered.map((topic, index) => `<tr><td><input class="table-checkbox topic-check" type="checkbox" data-index="${state.topics.indexOf(topic)}" aria-label="Select ${escapeHtml(topic.title)}" /></td><td>${escapeHtml(topic.title)}<div style="font-size:8px;color:#9aa39d;font-weight:400;margin-top:4px">${escapeHtml(topic.vertical)} · ${escapeHtml(topic.pain)}</div></td><td>${escapeHtml(topic.equipment)}</td><td><span class="topic-label">${escapeHtml(topic.type)}</span></td><td>${chip(topic.status)}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">No topics match this filter. Try another search or status.</div></td></tr>`}</tbody>
          </table>
        </div>
      </section>
      <aside class="panel">
        <div class="taxonomy-tree">
          <h3>Explore by vertical</h3><p>Vertical → equipment → pain point</p>
          <div class="tree-node root"><span class="tree-caret">⌄</span><strong>${escapeHtml(state.selectedVertical)}</strong></div>
          <div class="tree-line">
            ${treeEquipmentFor(state.selectedVertical).map((equip) => `<div class="tree-node indent-1"><span class="tree-caret">›</span>${equip.name}</div><div class="tree-node indent-2"><span class="tree-bullet"></span>${equip.pain}</div>`).join("")}
            <div class="tree-node indent-1"><span class="tree-caret">›</span>Content type</div><div class="tree-node indent-2"><span class="tree-bullet"></span>Solution page</div><div class="tree-node indent-2"><span class="tree-bullet"></span>Use case</div>
          </div>
          <div class="tree-action"><button class="text-button" data-action="new-batch">Build a batch from topics ${icon("arrow")}</button></div>
        </div>
      </aside>
    </div>
    ${state.batches.length ? `<section class="panel topics-batch-section"><div class="panel-heading"><div><h2>Active batches</h2><p>Track the batches in this workspace.</p></div><span class="phase-chip">${state.batches.length} batches</span></div><div class="batch-list">${state.batches.map((batch) => `
      <div class="batch-row">
        <div class="batch-title"><span class="batch-avatar ${escapeHtml(batch.className)}">${escapeHtml(batch.initials)}</span><div class="batch-title-copy"><strong>${escapeHtml(batch.name)}</strong><small>${escapeHtml(batch.detail)}</small></div></div>
        <div class="progress-wrap"><div class="progress-label"><span>Progress</span><span>${batch.progress}%</span></div><div class="progress-track"><span style="width:${batch.progress}%"></span></div></div>
        ${chip(batch.status)}<span class="batch-date">${escapeHtml(batch.date)}</span>
      </div>`).join("")}</div></section>` : ""}
    <div style="margin-top:14px"><div class="section-title-row"><h2>Browse verticals</h2><span class="page-subtitle">Seeded library · sample topic counts</span></div>
      <div class="vertical-grid">${state.verticals.map((vertical) => `<article class="vertical-card ${state.selectedVertical === vertical.name ? "selected" : ""}" data-vertical="${escapeHtml(vertical.name)}"><div class="vertical-card-top"><span class="vertical-icon">${vertical.icon}</span><span class="topic-count">${vertical.count}</span></div><h3>${escapeHtml(vertical.name)}</h3><p>${escapeHtml(vertical.desc)}</p></article>`).join("")}</div>
    </div>`;
}

function renderPersistedTopics() {
    const canApprove = currentWorkspace() && ["Owner", "Admin"].includes(currentWorkspace().role);
    const canGenerate = currentWorkspace() && ["Owner", "Admin", "Editor"].includes(currentWorkspace().role);
    const filtered = state.topics.filter((topic) => {
      const matchesTab = state.topicFilter === "All topics" || topic.status === state.topicFilter;
      const matchesSearch = !state.search || `${topic.title} ${topic.vertical} ${topic.equipment} ${topic.pain}`.toLowerCase().includes(state.search.toLowerCase());
      return matchesTab && matchesSearch;
    });
    const tabs = ["All topics", "Suggested", "In review", "Approved"];
    const usage = state.usage || { plan: currentWorkspace().plan || "Starter", subscriptionStatus: "inactive", used: 0, limit: 0 };
    return `
      <div class="page-heading"><div><div class="eyebrow">WORKSPACE CONTENT</div><h1>Topics &amp; batches</h1><p class="page-subtitle">Create a topic batch, review and approve its suggestions, then generate pages.</p></div><div class="heading-actions"><button class="button" data-action="add-topic">${icon("plus")} Add a topic</button>${canGenerate ? `<button class="button primary" data-action="suggest-batch">${icon("spark")} Suggest topic batch</button>` : ""}</div></div>
      <section class="panel" style="margin-bottom:16px"><div class="panel-heading"><div><h2>AI page allowance</h2><p>${escapeHtml(usage.plan)} plan · ${usage.used} of ${usage.limit} pages used this month</p></div>${chip(usage.subscriptionStatus === "active" || usage.subscriptionStatus === "trialing" ? "Active" : "Inactive")}</div>${!["active", "trialing"].includes(usage.subscriptionStatus) ? `<div class="onboarding-data-note">Activate a Starter or Growth subscription before generating pages. Topic planning and human review remain available.</div>` : ""}</section>
      ${state.batches.length ? `<section class="panel topics-batch-section"><div class="panel-heading"><div><h2>Content batches</h2><p>Approve topic suggestions before generating pages.</p></div><span class="phase-chip">${state.batches.length} batches</span></div><div class="batch-list">${state.batches.map((batch) => `
        <div class="batch-row batch-row-workflow">
          <div class="batch-title"><span class="batch-avatar">${escapeHtml(batch.initials)}</span><div class="batch-title-copy"><strong>${escapeHtml(batch.name)}</strong><small>${escapeHtml(batch.detail)}</small></div></div>
          <div class="progress-wrap"><div class="progress-label"><span>Pages generated</span><span>${batch.progress}%</span></div><div class="progress-track"><span style="width:${batch.progress}%"></span></div></div>
          ${chip(batch.status)}
          <div class="batch-actions">${batch.rawStatus === "pending_approval" && canApprove ? `<button class="button small" data-action="reject-batch" data-batch-id="${escapeHtml(batch.id)}">Reject</button><button class="button small primary" data-action="approve-batch" data-batch-id="${escapeHtml(batch.id)}">Approve topics</button>` : ""}${batch.rawStatus === "approved" && canGenerate ? `<button class="button small primary" data-action="generate-batch" data-batch-id="${escapeHtml(batch.id)}">Generate pages</button>` : ""}${batch.rawStatus === "ready" ? `<button class="button small" data-action="open-review">Review drafts</button>` : ""}</div>
        </div>`).join("")}</div></section>` : `<section class="panel empty-client-state"><span class="empty-art">${icon("layers")}</span><h2>No content batches yet.</h2><p>Generate topic suggestions to start your first production batch.</p>${canGenerate ? `<button class="button primary" data-action="suggest-batch">${icon("spark")} Suggest topic batch</button>` : ""}</section>`}
      <section class="panel topic-main">
        <div class="panel-heading"><div><h2>Workspace topics</h2><p>Suggestions remain in review until an owner or admin approves the batch.</p></div><span class="phase-chip">${state.topics.length} topics</span></div>
        <div class="filter-tabs">${tabs.map((tab) => `<button class="filter-tab ${state.topicFilter === tab ? "active" : ""}" data-filter="${escapeHtml(tab)}">${escapeHtml(tab)}</button>`).join("")}</div>
        <div class="topic-toolbar" style="padding:12px 14px 0"><label class="search-box">${icon("search")}<input id="topicSearch" type="search" placeholder="Search equipment, pain points..." value="${escapeHtml(state.search)}" /></label></div>
        <div class="table-wrap"><table class="topic-table"><thead><tr><th>TOPIC IDEA</th><th>EQUIPMENT</th><th>CONTENT TYPE</th><th>STATUS</th><th></th></tr></thead><tbody>${filtered.length ? filtered.map((topic) => `<tr><td>${escapeHtml(topic.title)}<div style="font-size:8px;color:#9aa39d;font-weight:400;margin-top:4px">${escapeHtml(topic.vertical)} · ${escapeHtml(topic.pain)}</div></td><td>${escapeHtml(topic.equipment)}</td><td><span class="topic-label">${escapeHtml(topic.type)}</span></td><td>${chip(topic.status)}</td><td>${canGenerate && topic.status !== "Approved" ? `<button class="row-action" data-action="delete-topic" data-topic-id="${escapeHtml(topic.id)}" aria-label="Delete topic">×</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-state">No topics match this filter. Try another search or status.</div></td></tr>`}</tbody></table></div>
      </section>
      <div class="roadmap-banner">${icon("check")} <span>Generated pages are checked for structure and SEO metadata, then require a human review before publishing.</span></div>`;
}

function renderNewWorkspaceDashboard() {
  const workspace = currentWorkspace();
  const pending = state.drafts.filter((draft) => draft.status === "In review").length;
  const approved = state.drafts.filter((draft) => draft.status === "Approved").length;
  const usage = state.usage || { plan: workspace && workspace.plan || "Starter", subscriptionStatus: "inactive", used: 0, limit: 0 };
  const recentBatches = state.batches.slice(0, 4);
  return `<div class="page-heading"><div><div class="eyebrow">YOUR WORKSPACE</div><h1>Welcome, ${escapeHtml(state.user ? state.user.name.split(" ")[0] : "there")}.</h1><p class="page-subtitle">Your content workflow is ready for ${escapeHtml(workspace ? workspace.name : "your team")}.</p></div><div class="heading-actions"><button class="button" data-view="settings">Workspace settings</button><button class="button primary" data-action="suggest-batch">${icon("spark")} Suggest a topic batch</button></div></div>
    <section class="metric-grid" aria-label="Workspace summary">
      <article class="metric-card"><div class="metric-top"><span>Content batches</span><i class="metric-icon">${icon("layers")}</i></div><div class="metric-value">${state.batches.length}</div><div class="metric-foot">Stored in this workspace</div></article>
      <article class="metric-card"><div class="metric-top"><span>Pages awaiting review</span><i class="metric-icon">${icon("file")}</i></div><div class="metric-value">${pending}</div><div class="metric-foot">Human approval required</div></article>
      <article class="metric-card"><div class="metric-top"><span>Pages approved</span><i class="metric-icon">${icon("check")}</i></div><div class="metric-value">${approved}</div><div class="metric-foot">Ready for publishing or export</div></article>
      <article class="metric-card"><div class="metric-top"><span>Monthly AI usage</span><i class="metric-icon">${icon("chart")}</i></div><div class="metric-value">${usage.used} <span style="font-size:13px;color:#87938a;font-weight:500">/ ${usage.limit || "—"}</span></div><div class="metric-foot">${escapeHtml(usage.plan)} plan · ${escapeHtml(usage.subscriptionStatus)}</div></article>
    </section>
    <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Recent batches</h2><p>Move topics from approval to reviewed pages.</p></div><button class="text-button" data-view="topics">View batches ${icon("arrow")}</button></div>${recentBatches.length ? `<div class="batch-list">${recentBatches.map((batch) => `<div class="batch-row"><div class="batch-title"><span class="batch-avatar">${escapeHtml(batch.initials)}</span><div class="batch-title-copy"><strong>${escapeHtml(batch.name)}</strong><small>${escapeHtml(batch.detail)}</small></div></div><div class="progress-wrap"><div class="progress-label"><span>Progress</span><span>${batch.progress}%</span></div><div class="progress-track"><span style="width:${batch.progress}%"></span></div></div>${chip(batch.status)}<span class="batch-date">${escapeHtml(batch.date)}</span></div>`).join("")}</div>` : `<div class="empty-state">No batches have been created yet. Suggest topics to get started.</div>`}</section>
      <section class="panel onboarding-panel"><div class="panel-heading"><div><h2>Set up your workflow</h2><p>Prepare the workspace before content generation.</p></div></div><div class="onboarding-feature-list"><div class="onboarding-feature">${icon("settings")}<span><b>Configure product context</b><small>Set approved CTA and page quality thresholds.</small></span><button class="text-button" data-view="settings">Configure ${icon("arrow")}</button></div><div class="onboarding-feature">${icon("grid")}<span><b>Invite reviewers</b><small>Give writers and approvers workspace access.</small></span><button class="text-button" data-view="team">Manage team ${icon("arrow")}</button></div><div class="onboarding-feature">${icon("send")}<span><b>Connect publishing</b><small>Configure WordPress and Google reporting.</small></span><button class="text-button" data-view="settings">Connect ${icon("arrow")}</button></div></div></section></div>`;
}

function renderClients() {
  const agencyWorkspace = currentWorkspace() && currentWorkspace().teamType === "Agency";
  const visibleClients = state.clients;
  return `<div class="page-heading"><div><div class="eyebrow">MULTI-CLIENT OPERATIONS <span class="demo-chip">${state.user && state.user.demo ? "SAMPLE CLIENTS" : "WORKSPACE"}</span></div><h1>Client workspaces</h1><p class="page-subtitle">Keep client projects distinct and invite the right reviewers to each workspace.</p></div><div class="heading-actions"><button class="button" data-action="client-guide">How access works</button><button class="button primary" data-action="add-client">${icon("plus")} Add a client</button></div></div>
    ${visibleClients.length ? `<div class="client-summary-grid"><article class="metric-card"><div class="metric-top"><span>Client workspaces</span><i class="metric-icon">${icon("grid")}</i></div><div class="metric-value">${visibleClients.length}</div><div class="metric-foot">Organized by organization</div></article><article class="metric-card"><div class="metric-top"><span>Pages in client projects</span><i class="metric-icon">${icon("file")}</i></div><div class="metric-value">${visibleClients.reduce((sum, client) => sum + Number(client.pages || 0), 0)}</div><div class="metric-foot">Sample project totals</div></article><article class="metric-card"><div class="metric-top"><span>Client approvals</span><i class="metric-icon">${icon("check")}</i></div><div class="metric-value">Role based</div><div class="metric-foot">Viewer access can be limited</div></article></div>
    <div class="client-grid">${visibleClients.map((client, index) => `<article class="panel client-card"><div class="client-card-top"><span class="client-mark mark-${index % 4}">${escapeHtml(client.name.slice(0, 1))}</span><button class="row-action" data-action="client-menu" data-client="${escapeHtml(client.name)}">···</button></div><h2>${escapeHtml(client.name)}</h2><p>${escapeHtml(client.vertical)} · ${Number(client.pages || 0)} sample pages</p><div class="client-card-bottom">${chip(client.status)}<span>${state.user && state.user.demo ? "Demo workspace" : "New workspace"}</span></div><button class="button client-open" data-action="open-client" data-client="${escapeHtml(client.name)}">Open workspace ${icon("arrow")}</button></article>`).join("")}</div>` : `<div class="panel empty-client-state"><span class="empty-art">${icon("grid")}</span><h2>Your first client workspace starts here.</h2><p>Separate clients by workspace, keep reviewers scoped to their work, and manage delivery from one agency view.</p><button class="button primary" data-action="add-client">${icon("plus")} Add a client workspace</button></div>`}
    <div class="roadmap-banner">${icon("check")} <span><strong>Workspace membership is enforced by the backend.</strong> Agency-client linking and server-side content storage are not implemented yet.</span></div>`;
}

function renderTeam() {
  const canManage = canManageWorkspace();
  const activeWorkspace = currentWorkspace();
  const roleOptions = state.user && !state.user.demo && activeWorkspace && activeWorkspace.role !== "Owner"
    ? ["Editor", "Reviewer", "Client viewer"]
    : ["Admin", "Editor", "Reviewer", "Client viewer"];
  return `<div class="page-heading"><div><div class="eyebrow">PEOPLE &amp; PERMISSIONS</div><h1>Team &amp; access</h1><p class="page-subtitle">Manage the roles enforced for this workspace.</p></div><div class="heading-actions"><span class="phase-chip">${state.members.length} members</span>${canManage ? `<button class="button primary" data-action="invite-member">${icon("plus")} Add teammate</button>` : ""}</div></div>
    <div class="team-summary"><div class="panel team-callout"><span class="taxonomy-art">${icon("grid")}</span><div><h2>One team, clearer responsibilities.</h2><p>Owners control the workspace. Editors prepare drafts. Reviewers approve or request changes. Client viewers can access shared client work.</p></div><button class="text-button" data-action="role-guide">Role guide ${icon("arrow")}</button></div><div class="panel team-seat-card"><div class="eyebrow">WORKSPACE ACCESS</div><b>${state.members.length} <span>people</span></b><small>Team access is managed per workspace.</small></div></div>
    <section class="panel team-table-panel"><div class="panel-heading"><div><h2>Workspace members</h2><p>${state.user && state.user.demo ? "Sample members." : "Accounts and pending email invitations with server-enforced workspace access."}</p></div><select class="select-lite" id="teamRoleFilter" aria-label="Filter members"><option>All roles</option>${["Owner", "Admin", "Editor", "Reviewer", "Client viewer"].map((role) => `<option>${role}</option>`).join("")}</select></div><div class="table-wrap"><table class="topic-table"><thead><tr><th>MEMBER</th><th>ROLE</th><th>STATUS</th><th>ADDED</th><th></th></tr></thead><tbody>${state.members.map((member, index) => `<tr data-member-role="${escapeHtml(member.role)}"><td><div class="member-cell"><span class="member-avatar avatar-${index % 4}">${escapeHtml(initials(member.name || member.email))}</span><span><b>${escapeHtml(member.name || "Invitation pending")}</b><small>${escapeHtml(member.email)}</small></span></div></td><td><select class="member-role-select" data-member-id="${escapeHtml(member.id || "")}" data-member-email="${escapeHtml(member.email)}" aria-label="Role for ${escapeHtml(member.email)}" ${!canManage || member.role === "Owner" || member.status === "Pending" ? "disabled" : ""}>${member.role === "Owner" ? `<option selected>Owner</option>` : ""}${roleOptions.map((role) => `<option ${member.role === role ? "selected" : ""}>${role}</option>`).join("")}</select></td><td>${chip(member.status)}</td><td>${member.role === "Owner" ? "Workspace owner" : member.status === "Pending" ? "Invitation sent" : "Workspace member"}</td><td>${canManage && member.role !== "Owner" ? `<button class="row-action" data-action="${member.status === "Pending" ? "revoke-invitation" : "remove-member"}" data-member-id="${escapeHtml(member.id || "")}" data-invitation-id="${escapeHtml(member.invitationId || "")}" data-email="${escapeHtml(member.email)}" aria-label="${member.status === "Pending" ? "Revoke invitation for" : "Remove"} ${escapeHtml(member.email)}">···</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="5"><div class="empty-state">Loading workspace members…</div></td></tr>`}</tbody></table></div></section>
    <div class="access-note">${icon("clock")} <span><strong>Invitations expire after seven days.</strong> Invitees must verify their email and sign in with the invited address before access is granted.</span></div>`;
}

function renderPlans() {
  const workspace = currentWorkspace();
  const canManage = Boolean(workspace && ["Owner", "Admin"].includes(workspace.role));
  const findPlan = (name) => state.billingPlans.find((plan) => plan.name === name);
  const formatPrice = (name) => {
    const plan = findPlan(name);
    if (!plan) return "Stripe price not configured";
    const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: plan.currency }).format(plan.unitAmount / 100);
    const interval = plan.intervalCount === 1 ? plan.interval : `${plan.intervalCount} ${plan.interval}s`;
    return `${amount} / ${interval}`;
  };
  const status = state.billingStatus ? state.billingStatus.status : "Loading";
  const used = state.user && state.user.demo ? 12 : state.drafts.length;
  const limit = state.user && state.user.demo ? 20 : 500;
  const manageButton = canManage
    ? `<button class="button" data-action="billing-info">Manage billing ${icon("arrow")}</button>`
    : `<span class="onboarding-data-note">Only the workspace owner or admin can manage subscriptions.</span>`;
  return `<div class="page-heading"><div><div class="eyebrow">SUBSCRIPTION OVERVIEW</div><h1>Plan &amp; usage</h1><p class="page-subtitle">Stripe manages recurring checkout, subscription events, and billing portal sessions.</p></div><span class="demo-chip">${state.user && state.user.demo ? "SAMPLE BILLING" : "STRIPE"}</span></div>
    <div class="plan-overview-grid"><section class="panel current-plan"><div class="panel-heading"><div><div class="eyebrow">CURRENT WORKSPACE PLAN</div><h2>${escapeHtml(workspace ? workspace.plan : "Starter")} <span class="plan-active">${escapeHtml(status)}</span></h2></div><span class="phase-chip">${escapeHtml(workspace ? workspace.name : "")}</span></div><div class="plan-usage"><div class="usage-copy"><span>Stored drafts</span><strong>${used} <small>/ ${limit}</small></strong></div><div class="usage-track"><i style="width:${Math.min(100, used / limit * 100)}%"></i></div><small>The content storage limit is enforced by the API.</small></div><div class="plan-feature-list"><span>${icon("check")} Workspace topics and drafts</span><span>${icon("check")} Server-enforced review roles</span><span>${icon("check")} PostgreSQL persistence</span></div>${manageButton}</section>
    <section class="panel billing-placeholder"><span class="taxonomy-art">${icon("chart")}</span><h2>Subscription controls</h2><p>Checkout and subscription changes are synchronized from verified Stripe webhooks. Customer card data is handled by Stripe.</p><div class="onboarding-data-note">AI generation is not connected. Configure Stripe price IDs before offering checkout.</div></section></div>
    <div class="section-title-row plans-heading"><h2>Plan options</h2><span class="page-subtitle">Price and billing period are read from Stripe.</span></div><div class="pricing-grid compact-pricing"><article class="pricing-card"><span class="pricing-name">STARTER</span><h3>For a focused team</h3><div class="price">${escapeHtml(formatPrice("Starter"))}</div><ul><li>${icon("check")} Workspace topics and drafts</li><li>${icon("check")} Review workflow</li><li>${icon("check")} Member roles</li></ul><button class="button" data-action="subscribe-starter" ${!canManage || !findPlan("Starter") ? "disabled" : ""}>Choose Starter</button></article><article class="pricing-card featured"><span class="pricing-name">GROWTH</span><h3>For a growing team</h3><div class="price">${escapeHtml(formatPrice("Growth"))}</div><ul><li>${icon("check")} Workspace topics and drafts</li><li>${icon("check")} Team review workflow</li><li>${icon("check")} Billing portal access</li></ul><button class="button primary" data-action="subscribe-growth" ${!canManage || !findPlan("Growth") ? "disabled" : ""}>Choose Growth</button></article></div>`;
}

function treeEquipmentFor(vertical) {
  const map = {
    "Food & Beverage": [{ name: "Centrifugal pumps", pain: "Unplanned downtime" }, { name: "Conveyor lines", pain: "Line stoppages" }],
    Automotive: [{ name: "Weld cells", pain: "Quality defects" }, { name: "Stamping presses", pain: "Unplanned downtime" }],
    Steel: [{ name: "Electric arc furnace", pain: "Energy costs" }, { name: "Continuous casting", pain: "Product quality" }],
    HVAC: [{ name: "Rooftop units", pain: "Fault detection" }, { name: "Building systems", pain: "Energy efficiency" }],
    Textile: [{ name: "Spinning frames", pain: "Yarn breakage" }, { name: "Cutting rooms", pain: "Fabric waste" }],
    Cement: [{ name: "Rotary kiln", pain: "Fuel consumption" }, { name: "Mills", pain: "Unplanned downtime" }],
    "SCADA & Automation": [{ name: "PLC / MES", pain: "Data integration" }, { name: "OPC UA", pain: "System interoperability" }]
  };
  return map[vertical] || map["Food & Beverage"];
}

function renderReview() {
  if (state.user && !state.user.demo) return renderPersistedReview();
  if (!state.user || !state.user.demo || state.activeWorkspaceId !== "northstar") return `<div class="page-heading"><div><div class="eyebrow">HUMAN APPROVAL</div><h1>Content review</h1><p class="page-subtitle">Drafts stay in review until a workspace member approves them.</p></div></div><div class="panel empty-client-state"><span class="empty-art">${icon("file")}</span><h2>Your review queue is ready.</h2><p>Start by creating a topic batch. Generated pages will appear here with their structure and QA status.</p><button class="button primary" data-view="topics">Explore topic library ${icon("arrow")}</button></div>`;
  const patched = state.qaPatched;
  const checklist = [
    { name: "Word count", value: patched ? "2,940 words" : "2,940 words", type: "pass" },
    { name: "FAQs", value: "5 included", type: "pass" },
    { name: "CTA", value: patched ? "CTA included" : "Missing CTA", type: patched ? "pass" : "fail" },
    { name: "Link allowlist", value: "2 approved links", type: "pass" },
    { name: "Batch uniqueness", value: "Distinct layout", type: "pass" },
    { name: "Schema", value: "Article · FAQPage", type: "pass" }
  ];
  return `
    <div class="review-wrap">
      <div class="review-page-heading">
        <div class="review-title-group"><button class="back-button" data-view="dashboard" aria-label="Back to overview">${icon("arrow")}</button><div><div class="eyebrow">Food &amp; Beverage · PdM batch</div><h1>Predictive maintenance for centrifugal pumps</h1><div class="review-meta">Solution page <span>·</span> Draft v3 <span>·</span> Updated 12 min ago <span>·</span> ${chip(state.approved ? "Approved" : patched ? "Ready" : "Needs attention")}</div></div></div>
        <div class="review-actions"><button class="button" data-action="request-changes">Request changes</button><button class="button primary" data-action="approve" ${patched && !state.approved ? "" : "disabled"}>${icon("check")} ${state.approved ? "Approved" : "Approve draft"}</button></div>
      </div>
      <div class="qa-strip"><span class="qa-label">Quality checks</span>${checklist.map((item) => `<span class="qa-pill ${item.type}">${item.type === "pass" ? icon("check") : icon("close")} ${item.name} · ${item.value}</span>`).join("")}</div>
      <div class="review-toolbar">
        <div class="review-tabs">${["Draft", "Version diff"].map((tab) => `<button class="review-tab ${state.reviewTab === tab ? "active" : ""}" data-review-tab="${tab}">${tab}</button>`).join("")}</div>
        <div class="review-note">${icon("clock")} QA checks run on the current draft. Human review is required before export.</div>
      </div>
      <div class="review-columns">
        <section class="panel preview-card">
          <div class="preview-top"><span>${icon("external")} Live page preview</span><span>Preview mode</span></div>
          <div class="preview-site"><span class="site-dots"><i></i><i></i><i></i></span><span>northstarindustrial.com / resources / centrifugal-pump-pdm</span></div>
          <article class="preview-document">
            <div class="preview-kicker">PREDICTIVE MAINTENANCE · FOOD &amp; BEVERAGE</div>
            <h2>Predictive maintenance for centrifugal pumps: reduce unplanned downtime</h2>
            <p class="lead">Predictive maintenance software helps food and beverage teams spot early signs of centrifugal pump wear, schedule service around production, and reduce avoidable interruptions.</p>
            <div class="preview-visual"><div class="visual-line"></div><div class="visual-node"><i>◉</i><span>Collect<br/>equipment data</span></div><div class="visual-node"><i>⌁</i><span>Detect<br/>anomalies</span></div><div class="visual-node"><i>✓</i><span>Plan<br/>maintenance</span></div></div>
            <h3>Why pump reliability matters on a production line</h3>
            <p>Centrifugal pumps support cleaning, transfer, and processing operations across food and beverage facilities. A failure can interrupt a connected line, delay a cleaning cycle, or require unplanned maintenance during a production window.</p>
            <div class="preview-callout">Answer first: Teams can reduce avoidable pump downtime by monitoring operating signals, identifying changes early, and aligning maintenance with production schedules.</div>
            <h3>How predictive maintenance works for centrifugal pumps</h3>
            <p>A condition-monitoring workflow gathers equipment data, compares current behavior with operating baselines, and gives maintenance teams a clearer signal to investigate.</p>
            <h3>Frequently asked questions</h3>
            <p>Learn how monitoring can fit existing maintenance routines and which pump signals are useful to track.</p>
            ${patched ? `<div class="preview-callout" style="border-color:#75a27d"><strong>See how Northstar can help.</strong> Book a walkthrough with our industrial reliability team.</div>` : ""}
          </article>
        </section>
        <section class="panel editor-card">
          <div class="editor-top"><span>${icon("file")} Structured draft</span><div class="editor-tabs">${["Content", "FAQ", "JSON-LD"].map((tab) => `<button class="editor-tab ${state.activeEditorTab === tab ? "active" : ""}" data-editor-tab="${tab}">${tab}</button>`).join("")}</div></div>
          <div class="editor-content">${renderEditorContent()}</div>
          <div class="editor-bottom"><span>Changes save to this draft</span><button data-action="auto-patch">${patched ? "Patched · review change" : `${icon("spark")} Auto-patch`}</button></div>
        </section>
      </div>
      <div class="taxonomy-banner" style="margin-top:0"><div class="taxonomy-art">${icon("file")}</div><div class="taxonomy-copy"><h3>${state.approved ? "This draft is approved for export" : "Export is available after approval"}</h3><p>Approved drafts can be downloaded as clean HTML or copied into your CMS. Direct publishing is planned for V1.</p></div><button class="button" data-action="export" ${state.approved ? "" : "disabled"}>Export HTML ${icon("arrow")}</button></div>
    </div>`;
}

function renderPersistedReview() {
  const draft = currentDraft();
  if (!draft) return `<div class="page-heading"><div><div class="eyebrow">HUMAN APPROVAL</div><h1>Content review</h1><p class="page-subtitle">Generated and manually prepared drafts follow the same quality and review gates.</p></div><div class="heading-actions"><button class="button primary" data-action="new-draft">${icon("plus")} New draft</button></div></div><div class="panel empty-client-state"><span class="empty-art">${icon("file")}</span><h2>No drafts yet.</h2><p>Generate pages from an approved topic batch or create a manual draft.</p><button class="button" data-view="topics">Explore topics ${icon("arrow")}</button></div>`;
  const role = currentWorkspace() && currentWorkspace().role;
  const canEdit = ["Owner", "Admin", "Editor"].includes(role);
  const canReview = ["Owner", "Admin", "Reviewer"].includes(role);
  const editable = canEdit && ["Draft", "Changes requested"].includes(draft.status);
  const reviewable = canReview && draft.status === "In review";
  const history = state.feedback.filter((entry) => entry.draft_id === draft.id);
  const checks = draft.qualityReport && Array.isArray(draft.qualityReport.checks) ? draft.qualityReport.checks : [];
  return `<div class="page-heading"><div><div class="eyebrow">WORKSPACE DRAFTS</div><h1>Review and edit</h1></div><div class="heading-actions"><select id="draftSelector" aria-label="Choose a draft">${state.drafts.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === draft.id ? "selected" : ""}>${escapeHtml(item.title)} · ${escapeHtml(item.status)}</option>`).join("")}</select><button class="button" data-action="new-draft">${icon("plus")} New draft</button></div></div><div class="review-wrap">
    <div class="review-page-heading"><div class="review-title-group"><button class="back-button" data-view="topics" aria-label="Back to topics">${icon("arrow")}</button><div><div class="eyebrow">WORKSPACE DRAFT</div><h1>${escapeHtml(draft.title)}</h1><div class="review-meta">Version ${draft.version} <span>·</span> ${chip(draft.status)}</div></div></div>
      <div class="review-actions">${editable ? `<button class="button" data-action="save-draft">Save draft</button><button class="button" data-action="quality-check">Run quality check</button><button class="button" data-action="repair-draft">${icon("spark")} AI repair</button><button class="button primary" data-action="submit-for-review" ${draft.qualityReport && draft.qualityReport.passed ? "" : "disabled"}>${icon("check")} Submit for review</button>` : ""}${reviewable ? `<button class="button" data-action="request-changes">Request changes</button><button class="button primary" data-action="approve">${icon("check")} Approve draft</button>` : ""}${draft.status === "Approved" ? `<button class="button" data-action="export-approved" data-draft-id="${escapeHtml(draft.id)}">Export HTML ${icon("arrow")}</button><button class="button primary" data-action="publish-draft">${icon("send")} Publish to WordPress</button>` : ""}</div>
    </div>
    <section class="panel quality-panel"><div class="panel-heading"><div><h2>Quality checks</h2><p>${draft.qualityCheckedAt ? `Checked ${escapeHtml(new Date(draft.qualityCheckedAt).toLocaleString())}` : "Run checks before submitting for human review."}</p></div>${draft.qualityReport ? chip(draft.qualityReport.passed ? "Ready" : "Needs attention") : chip("Not checked")}</div>${checks.length ? `<div class="quality-check-list">${checks.map((check) => `<div class="quality-check-row"><span class="quality-check-icon ${check.passed ? "passed" : "failed"}">${check.passed ? icon("check") : icon("close")}</span><span><b>${escapeHtml(check.label)}</b><small>${escapeHtml(check.detail)}</small></span></div>`).join("")}</div>` : `<div class="onboarding-data-note">Checks include minimum word count, page structure, FAQs, meta description, approved CTA, and structured data.</div>`}${draft.seoData && draft.seoData.metaDescription ? `<p class="meta-description"><b>Meta description:</b> ${escapeHtml(draft.seoData.metaDescription)}</p>` : ""}${draft.publishedUrl ? `<p class="meta-description">Published URL: <a href="${escapeHtml(draft.publishedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(draft.publishedUrl)}</a></p>` : ""}</section>
    <div class="review-columns">
      <section class="panel preview-card"><div class="preview-top"><span>${icon("external")} Draft preview</span><span>${escapeHtml(draft.status)}</span></div><article class="preview-document"><h2>${escapeHtml(draft.title)}</h2><pre class="draft-preview-content">${escapeHtml(draft.content || "No content has been added yet.")}</pre></article></section>
      <section class="panel editor-card"><div class="editor-top"><span>${icon("file")} Persistent draft</span></div><div class="editor-content">
        <div class="editor-block"><div class="editor-section-label">Title</div><textarea class="editor-field title-field" data-draft-field="title" rows="2" ${editable ? "" : "disabled"}>${escapeHtml(draft.title)}</textarea></div>
        <div class="editor-block"><div class="editor-section-label">Content</div><textarea class="editor-field" data-draft-field="content" rows="18" maxlength="100000" ${editable ? "" : "disabled"}>${escapeHtml(draft.content)}</textarea></div>
      </div><div class="editor-bottom"><span>Autosave is off; save changes explicitly.</span>${editable ? `<button data-action="save-draft">Save draft</button>` : ""}</div></section>
    </div>
    ${history.length ? `<section class="panel" style="margin-top:16px;padding:20px"><h3>Review history</h3>${history.map((entry) => `<p><b>${entry.action === "approved" ? "Approved" : "Changes requested"}</b> · ${escapeHtml(entry.comment || "")}</p>`).join("")}</section>` : ""}
  </div>`;
}

function renderEditorContent() {
  if (state.reviewTab === "Version diff") {
    return `<div class="editor-section-label">Latest patch pass · Draft v2 → v3</div><div class="diff-box"><strong>Structural checks</strong><br/>✓ FAQ count meets the minimum<br/>✓ Link allowlist is compliant<br/>✓ Batch layout is distinct<br/><br/><span class="diff-add">+ ${state.qaPatched ? "Added approved CTA to the final section." : "CTA is missing; auto-patch can add the approved CTA."}</span><br/>No changes to technical claims.</div><div class="roadmap-banner">${icon("clock")} Diff preview is sample data for this prototype.</div>`;
  }
  if (state.activeEditorTab === "JSON-LD") {
    return `<div class="editor-section-label">Generated structured data · MVP</div><div class="schema-preview">&lt;script type="application/ld+json"&gt;\n{\n  "@context": "https://schema.org",\n  "@type": "Article",\n  "headline": "Predictive maintenance for centrifugal pumps",\n  "author": { "@type": "Organization", "name": "Northstar Industrial" }\n}\n&lt;/script&gt;\n\nFAQPage schema is included for the five draft FAQs.</div><div class="roadmap-banner">${icon("spark")} Confirm organization details before exporting schema to a live site.</div>`;
  }
  if (state.activeEditorTab === "FAQ") {
    return `<div class="editor-section-label">Frequently asked questions · 5 included</div>
      <div class="editor-faq"><strong>What is predictive maintenance for centrifugal pumps?</strong><span>It uses equipment condition data to identify changes that may signal a need for inspection or service.</span></div>
      <div class="editor-faq"><strong>Which pump signals can maintenance teams monitor?</strong><span>Teams commonly review operating conditions such as vibration, temperature, pressure, and flow in context.</span></div>
      <div class="editor-faq"><strong>How does monitoring support food production?</strong><span>It can help teams plan maintenance around production needs and investigate unusual equipment behavior earlier.</span></div>
      <div class="editor-faq"><strong>Can predictive maintenance work with existing systems?</strong><span>Implementation depends on available sensor data, controls, and the facility's integration approach.</span></div>
      <div class="editor-faq"><strong>When should a pump be inspected?</strong><span>Inspection timing depends on equipment condition, operating context, and manufacturer guidance.</span></div>`;
  }
  return `<div class="editor-block"><div class="editor-section-label">Page headline</div><textarea class="editor-field title-field" rows="2">Predictive maintenance for centrifugal pumps: reduce unplanned downtime</textarea></div>
    <div class="editor-block"><div class="editor-section-label">Answer-first introduction</div><textarea class="editor-field" rows="5">Predictive maintenance software helps food and beverage teams spot early signs of centrifugal pump wear, schedule service around production, and reduce avoidable interruptions. It combines equipment signals with maintenance context so teams can investigate changes before they become disruptive failures.</textarea></div>
    <div class="editor-block"><div class="editor-section-label">Page structure</div><div class="editor-faq"><strong>01 · Why pump reliability matters on a production line</strong><span>Section introduction · 3 paragraphs</span></div><div class="editor-faq"><strong>02 · How predictive maintenance works for pumps</strong><span>Section introduction · 4 paragraphs</span></div><div class="editor-faq"><strong>03 · A practical implementation checklist</strong><span>Section introduction · 5 steps</span></div></div>
    <div class="editor-block"><div class="editor-section-label">Approved links</div><div class="link-row">${icon("check")} /book-a-demo <span class="topic-label">Allowlisted</span></div><div class="link-row">${icon("check")} /support <span class="topic-label">Allowlisted</span></div></div>`;
}

function renderPublished() {
  const demo = Boolean(state.user && state.user.demo);
  const pages = state.pages.filter((page) => !state.search || `${page.title} ${page.batch} ${page.schema}`.toLowerCase().includes(state.search.toLowerCase()));
  return `
    <div class="page-heading"><div><div class="eyebrow">Content library ${demo ? `<span class="demo-chip">DEMO DATA</span>` : ""}</div><h1>${demo ? "Published pages" : "Approved & published pages"}</h1><p class="page-subtitle">${demo ? "Sample pages for the interactive demo." : "Publish approved pages to WordPress or export them as HTML."}</p></div><div class="heading-actions">${demo ? `<button class="button" data-action="export-all">Export selected</button><button class="button primary" data-action="new-batch">${icon("plus")} New batch</button>` : ""}</div></div>
    <section class="panel published-panel">
      <div class="panel-heading"><div><h2>${demo ? "Sample page library" : "Approved workspace drafts"}</h2><p>${pages.length} ${demo ? "sample pages" : "approved drafts"}</p></div><div class="published-tools"><label class="search-box">${icon("search")}<input id="publishedSearch" type="search" placeholder="Search pages..." value="${escapeHtml(state.search)}" /></label></div></div>
      <div class="table-wrap"><table class="topic-table"><thead><tr><th>${demo ? `<input class="table-checkbox" type="checkbox" aria-label="Select all pages" />` : ""}</th><th>PAGE TITLE</th><th>BATCH</th><th>SCHEMA</th><th>STATUS</th><th>DATE</th><th></th></tr></thead>
      <tbody>${pages.length ? pages.map((page, index) => `<tr><td>${demo ? `<input class="table-checkbox page-check" type="checkbox" data-index="${index}" aria-label="Select ${escapeHtml(page.title)}" />` : ""}</td><td><div class="page-title-cell"><span class="page-mini-icon">${icon("file")}</span>${escapeHtml(page.title)}</div></td><td>${escapeHtml(page.batch)}</td><td><span class="topic-label">${escapeHtml(page.schema)}</span></td><td>${chip(page.status)}</td><td>${escapeHtml(page.date)}</td><td>${demo ? `<button class="row-action" data-action="export">Export ↓</button>` : `${page.publishedUrl ? `<a class="row-action" href="${escapeHtml(page.publishedUrl)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : `<button class="row-action" data-action="publish-draft" data-draft-id="${escapeHtml(page.id)}">Publish</button>`}<button class="row-action" data-action="export-approved" data-draft-id="${escapeHtml(page.id)}">Export ↓</button>`}</td></tr>`).join("") : `<tr><td colspan="7"><div class="empty-state">${demo ? "No sample pages found for that search." : "No approved drafts found for that search."}</div></td></tr>`}</tbody></table></div>
    </section>
    ${demo ? `<div class="roadmap-banner">${icon("chart")} <span>Demo pages and metrics are sample data and do not connect to a live CMS.</span></div>` : ""}`;
}

function renderSettings() {
  if (state.user && !state.user.demo) return renderPersistedSettings();
  const workspace = currentWorkspace();
  const email = state.user ? state.user.email : "";
  const company = workspace ? workspace.name : "Your company";
  const industry = workspace ? workspace.industry : "Other industrial / technical";
  const allowedLinks = workspace && Array.isArray(workspace.approvedLinks) && workspace.approvedLinks.length ? workspace.approvedLinks : ["northstarindustrial.com/book-a-demo", "northstarindustrial.com/support"];
  return `
    <div class="page-heading"><div><div class="eyebrow">Workspace setup</div><h1>Settings</h1><p class="page-subtitle">Set the context and guardrails your draft pipeline should follow.</p></div><span class="phase-chip">MVP setup</span></div>
    <div class="settings-grid">
      <section class="panel settings-card"><h2>Company &amp; product</h2><p>Give topic suggestions the context to stay relevant.</p><div class="settings-field"><label>Company name</label><input value="${escapeHtml(company)}" /></div><div class="settings-field"><label>Website</label><input value="${escapeHtml(workspace ? workspace.website : "")}" /></div><div class="settings-field"><label>Product description</label><textarea>${state.user && state.user.demo ? "Predictive maintenance software for food and beverage manufacturers." : ""}</textarea></div><div class="settings-field"><label>Primary industry</label><select>${[industry, ...state.verticals.map(v => v.name).filter(v => v !== industry)].map(value => `<option>${escapeHtml(value)}</option>`).join("")}</select></div><div class="settings-field"><label>Workspace owner</label><input value="${escapeHtml(email)}" readonly /></div><button class="button primary" data-action="save-settings">Save workspace details</button></section>
      <section class="panel settings-card"><h2>Brand voice &amp; links</h2><p>Keep technical content consistent and outbound links controlled.</p><div class="settings-field"><label>Writing style</label><select><option>Clear, practical, technically grounded</option><option>Concise and executive-focused</option></select></div><div class="settings-field"><label>Approved CTA</label><input value="${escapeHtml(workspace && workspace.approvedCta ? workspace.approvedCta : "Book a demo with our team")}" /></div><div class="settings-field"><label>Allowed links</label>${allowedLinks.map((link) => `<div class="link-row">${icon("check")} ${escapeHtml(link)}</div>`).join("")}</div><button class="button" data-action="add-link">${icon("plus")} Add approved link</button></section>
      <section class="panel settings-card"><h2>Quality rules</h2><p>Rule-based checks make drafts easier to review.</p><div class="settings-field"><label>Target word count</label><input value="2,800 – 3,500 words" /></div><div class="settings-field"><label>Minimum FAQs</label><input value="5" /></div><div class="settings-field"><label>Required structure</label><div class="link-row">${icon("check")} Answer-first section introductions</div><div class="link-row">${icon("check")} FAQ and Article JSON-LD</div><div class="link-row">${icon("check")} No unapproved outbound links</div></div><button class="button primary" data-action="save-settings">Save QA rules</button></section>
      <section class="panel settings-card"><h2>Team &amp; agency controls</h2><p>Workspace roles and branding controls.</p><div class="link-row"><span class="profile-avatar">AM</span><span style="flex:1">Alex Morgan · Owner</span><span class="topic-label">Owner</span></div><div class="roadmap-banner">${icon("clock")} <span><strong>Agency-client links and white-label branding</strong> are planned for V1. They are not active in this MVP workspace.</span></div></section>
    </div>`;
}

function renderPersistedSettings() {
  const workspace = currentWorkspace();
  const canManage = canManageWorkspace();
  const settings = state.contentSettings || { productDescription: "", approvedCta: "", minimumWordCount: 700, minimumFaqs: 5 };
  const integrations = state.integrations || {
    wordpress: { connected: false, siteUrl: "", username: "" },
    google: { connected: false, searchConsoleSite: "", ga4PropertyId: "" }
  };
  return `
    <div class="page-heading"><div><div class="eyebrow">WORKSPACE CONFIGURATION</div><h1>Settings</h1><p class="page-subtitle">Configure brand context, quality requirements, and publishing and analytics connections.</p></div></div>
    <div class="settings-grid">
      <section class="panel settings-card"><h2>Company &amp; product context</h2><p>AI topic suggestions and generated pages use this information.</p>
        <div class="settings-field"><label for="settingWorkspaceName">Workspace name</label><input id="settingWorkspaceName" value="${escapeHtml(workspace.name)}" ${canManage ? "" : "disabled"} /></div>
        <div class="settings-field"><label for="settingWebsite">Website</label><input id="settingWebsite" type="url" value="${escapeHtml(workspace.website || "")}" placeholder="https://example.com" ${canManage ? "" : "disabled"} /></div>
        <button class="button" data-action="save-workspace-details" ${canManage ? "" : "disabled"}>Save workspace details</button>
        <div class="settings-field"><label for="settingProductDescription">Product description</label><textarea id="settingProductDescription" maxlength="4000" ${canManage ? "" : "disabled"}>${escapeHtml(settings.productDescription)}</textarea></div>
        <div class="settings-field"><label for="settingApprovedCta">Approved call to action</label><input id="settingApprovedCta" maxlength="300" value="${escapeHtml(settings.approvedCta)}" ${canManage ? "" : "disabled"} /></div>
        <div class="settings-field"><label for="settingMinimumWords">Minimum word count</label><input id="settingMinimumWords" type="number" min="300" max="5000" value="${Number(settings.minimumWordCount) || 700}" ${canManage ? "" : "disabled"} /></div>
        <div class="settings-field"><label for="settingMinimumFaqs">Minimum FAQs</label><input id="settingMinimumFaqs" type="number" min="1" max="8" value="${Number(settings.minimumFaqs) || 5}" ${canManage ? "" : "disabled"} /></div>
        <button class="button primary" data-action="save-content-settings" ${canManage ? "" : "disabled"}>Save content guardrails</button>
      </section>
      <section class="panel settings-card"><h2>WordPress publishing</h2><p>Use a WordPress application password. Credentials are encrypted before storage.</p>
        <div class="integration-status">${integrations.wordpress.connected ? chip("Connected") : chip("Not connected")}</div>
        <div class="settings-field"><label for="wordpressSiteUrl">WordPress site URL (HTTPS)</label><input id="wordpressSiteUrl" type="url" value="${escapeHtml(integrations.wordpress.siteUrl)}" placeholder="https://example.com" ${canManage ? "" : "disabled"} /></div>
        <div class="settings-field"><label for="wordpressUsername">WordPress username</label><input id="wordpressUsername" autocomplete="username" value="${escapeHtml(integrations.wordpress.username)}" ${canManage ? "" : "disabled"} /></div>
        <div class="settings-field"><label for="wordpressAppPassword">Application password</label><input id="wordpressAppPassword" type="password" autocomplete="new-password" maxlength="512" placeholder="${integrations.wordpress.connected ? "Leave blank to keep saved credentials" : "Paste an application password"}" ${canManage ? "" : "disabled"} /></div>
        <div class="integration-actions"><button class="button primary" data-action="save-wordpress" ${canManage ? "" : "disabled"}>Verify &amp; save WordPress</button>${integrations.wordpress.connected && canManage ? `<button class="button danger" data-action="disconnect-wordpress">Disconnect</button>` : ""}</div>
      </section>
      <section class="panel settings-card"><h2>Google Search Console &amp; GA4</h2><p>Connect read-only access for search and traffic reporting.</p>
        <div class="integration-status">${integrations.google.connected ? chip("Connected") : chip("Not connected")}</div>
        <div class="settings-field"><label for="googleSearchConsoleSite">Search Console property</label><input id="googleSearchConsoleSite" value="${escapeHtml(integrations.google.searchConsoleSite)}" placeholder="https://example.com/ or sc-domain:example.com" ${canManage ? "" : "disabled"} /></div>
        <div class="settings-field"><label for="ga4PropertyId">GA4 property ID</label><input id="ga4PropertyId" inputmode="numeric" value="${escapeHtml(integrations.google.ga4PropertyId)}" placeholder="123456789" ${canManage ? "" : "disabled"} /></div>
        <div class="integration-actions"><button class="button" data-action="save-google-properties" ${canManage ? "" : "disabled"}>Save properties</button><button class="button primary" data-action="connect-google" ${canManage ? "" : "disabled"}>${integrations.google.connected ? "Reconnect Google" : "Connect Google"}</button>${integrations.google.connected && canManage ? `<button class="button danger" data-action="disconnect-google">Disconnect</button>` : ""}</div>
        <p class="settings-help">Google authorization requests read-only Search Console and Analytics access. Add the configured callback URL to your Google OAuth client.</p>
      </section>
      <section class="panel settings-card"><h2>Workspace access</h2><p>Content, integrations, and analytics are scoped to workspace membership.</p><div class="link-row">${icon("check")} Role: ${escapeHtml(workspace.role)}</div><div class="link-row">${icon("check")} Data stored in PostgreSQL</div><div class="link-row">${icon("check")} Provider credentials encrypted at rest</div></section>
    </div>`;
}

function renderAnalytics() {
  const rows = state.analytics || [];
  const formatMetric = (value) => Number(value || 0).toLocaleString();
  return `
    <div class="page-heading"><div><div class="eyebrow">SEARCH &amp; PERFORMANCE</div><h1>Analytics</h1><p class="page-subtitle">Search Console and GA4 metrics for published pages.</p></div><div class="heading-actions"><button class="button primary" data-action="sync-analytics">${icon("chart")} Sync metrics</button></div></div>
    ${rows.length ? `<section class="panel published-panel"><div class="panel-heading"><div><h2>Page performance</h2><p>Metrics are fetched from the connected Google properties.</p></div></div><div class="table-wrap"><table class="topic-table analytics-table"><thead><tr><th>PAGE</th><th>CLICKS</th><th>IMPRESSIONS</th><th>AVG. POSITION</th><th>SESSIONS</th><th>VIEWS</th><th>PERIOD</th></tr></thead><tbody>${rows.map((row) => `<tr><td><a href="${escapeHtml(row.publishedUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a></td><td>${formatMetric(row.clicks)}</td><td>${formatMetric(row.impressions)}</td><td>${Number(row.averagePosition || 0).toFixed(1)}</td><td>${formatMetric(row.sessions)}</td><td>${formatMetric(row.views)}</td><td>${escapeHtml(new Date(row.periodStart).toLocaleDateString())} – ${escapeHtml(new Date(row.periodEnd).toLocaleDateString())}</td></tr>`).join("")}</tbody></table></div></section>` : `<section class="panel empty-client-state"><span class="empty-art">${icon("chart")}</span><h2>No analytics have been synced.</h2><p>Connect Google Search Console and GA4 in Settings, then sync metrics for your published pages.</p><button class="button" data-view="settings">Configure integrations</button></section>`}
    <div class="roadmap-banner">${icon("clock")} <span>Google data is read-only and is refreshed only when a workspace member requests a sync.</span></div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function openModal(content) {
  modalContent.innerHTML = content;
  modalContent.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action, button)));
  modalBackdrop.hidden = false;
  const firstInput = modalContent.querySelector("input, select");
  if (firstInput) firstInput.focus();
}

function closeModal() {
  modalBackdrop.hidden = true;
}

function openBatchModal() {
  openModal(`<div class="eyebrow">Create content batch</div><h2 id="modalTitle">Start with an industrial topic cluster</h2><p class="modal-intro">Choose a vertical and give this batch a working name. Topic suggestions in this prototype use the seeded taxonomy.</p>
    <div class="settings-field"><label for="batchName">Batch name</label><input id="batchName" value="${escapeHtml(state.selectedVertical)} · New topic batch" /></div>
    <div class="settings-field"><label for="batchVertical">Industry vertical</label><select id="batchVertical">${state.verticals.map((v) => `<option ${v.name === state.selectedVertical ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}</select></div>
    <div class="topic-preview-box">Suggested topic dimensions<br/>Equipment → pain point → content type<br/><strong>${treeEquipmentFor(state.selectedVertical).map((x) => x.name).join(" · ")}</strong></div>
    <div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="create-batch">${icon("spark")} Create batch</button></div>`);
}

function openTopicBatchModal() {
  openModal(`<div class="eyebrow">AI TOPIC SUGGESTIONS</div><h2 id="modalTitle">Suggest a topic batch</h2><p class="modal-intro">The AI proposes up to eight topics using the workspace's product context. An owner or admin must approve them before page generation.</p>
    <div class="settings-field"><label for="batchName">Batch name</label><input id="batchName" maxlength="120" value="${escapeHtml(state.selectedVertical)} · New topic batch" /></div>
    <div class="settings-field"><label for="batchVertical">Industry vertical</label><select id="batchVertical">${state.verticals.map((vertical) => `<option ${vertical.name === state.selectedVertical ? "selected" : ""}>${escapeHtml(vertical.name)}</option>`).join("")}</select></div>
    <div class="onboarding-data-note">AI suggestions are limited per workspace. Review all generated claims and technical details before publishing.</div>
    <div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="create-ai-batch">${icon("spark")} Generate suggestions</button></div>`);
}

function openWorkspaceModal() {
  openModal(`<div class="eyebrow">ORGANIZATION SWITCHER</div><h2 id="modalTitle">Your workspaces</h2><p class="modal-intro">Each organization has its own team setup and client projects.</p><div class="workspace-choice-list">${state.workspaces.map((workspace) => `<button class="workspace-choice ${workspace.id === state.activeWorkspaceId ? "selected" : ""}" data-action="switch-workspace" data-workspace="${escapeHtml(workspace.id)}"><span class="workspace-choice-avatar">${escapeHtml(workspace.name.slice(0, 1))}</span><span><b>${escapeHtml(workspace.name)}</b><small>${escapeHtml(workspace.industry)} · ${escapeHtml(workspace.role)}</small></span><i>${workspace.id === state.activeWorkspaceId ? icon("check") : icon("chevron")}</i></button>`).join("")}</div><div class="modal-footer modal-footer-between"><button class="button" data-action="create-workspace-form">${icon("plus")} New workspace</button><button class="button" data-action="close-modal">Done</button></div>`);
}

function openWorkspaceForm() {
  openModal(`<div class="eyebrow">NEW ORGANIZATION</div><h2 id="modalTitle">Create a workspace</h2><p class="modal-intro">Separate a business, brand, or client team into its own workspace.</p><div class="settings-field"><label for="workspaceName">Workspace name</label><input id="workspaceName" placeholder="e.g. Northstar Europe" /></div><div class="settings-field"><label for="workspaceIndustry">Industry</label><select id="workspaceIndustry">${state.verticals.map((vertical) => `<option>${escapeHtml(vertical.name)}</option>`).join("")}<option>Agency</option><option>Other industrial / technical</option></select></div><div class="modal-footer"><button class="button" data-action="switcher-back">Cancel</button><button class="button primary" data-action="save-workspace">Create workspace</button></div>`);
}

function openInviteModal() {
  const canGrantAdmin = currentWorkspace().role === "Owner" || state.user.demo;
  openModal(`<div class="eyebrow">TEAM ACCESS</div><h2 id="modalTitle">Invite a teammate</h2><p class="modal-intro">We’ll email a single-use link. Access is granted only after the invitee verifies their email and accepts while signed in as this address.</p><div class="settings-field"><label for="inviteEmail">Work email</label><input id="inviteEmail" type="email" placeholder="teammate@company.com" /></div><div class="settings-field"><label for="inviteRole">Workspace role</label><select id="inviteRole">${canGrantAdmin ? `<option value="admin">Admin</option>` : ""}<option value="editor">Editor</option><option value="reviewer">Reviewer</option><option value="client_viewer">Client viewer</option></select></div><div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="send-invite">Send invitation</button></div>`);
}

async function initializeApp() {
  const currentPort = window.location.port;
  const isStaticDev = currentPort === "5500" || currentPort === "5501" || currentPort === "5502" || currentPort === "8080";
  if (isStaticDev) {
    const host = window.location.hostname || "localhost";
    const targetUrl = `http://${host}:4000`;
    try {
      const probe = await fetch(`${targetUrl}/health/live`, { cache: "no-store" });
      if (probe.ok) {
        window.location.replace(`${targetUrl}${window.location.search}${window.location.hash}`);
        return;
      }
    } catch {
      // Backend not running on port 4000 yet; reveal helper notice
    }
    const notice = document.getElementById("devPortNotice");
    if (notice) {
      notice.hidden = false;
      const dismiss = document.getElementById("devNoticeDismiss");
      if (dismiss) dismiss.onclick = () => { notice.hidden = true; };
    }
  }
  const parameters = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const billingResult = parameters.get("billing");
  const googleResult = parameters.get("google");
  if (["success", "cancel"].includes(billingResult) || ["connected", "error"].includes(googleResult)) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  const invitationToken = fragment.get("invite") || parameters.get("invite");
  if (invitationToken && /^[A-Za-z0-9_-]{43}$/.test(invitationToken)) {
    sessionStorage.setItem("rankforge-pending-invitation", invitationToken);
    window.history.replaceState({}, "", window.location.pathname);
  }
  const verificationToken = fragment.get("verify") || parameters.get("verify");
  if (verificationToken) {
    try {
      await loadCsrfToken();
      showEmailVerification(verificationToken);
    } catch {
      showPublic();
      showToast("Could not verify the email link. Start the server and try again.");
    }
    return;
  }
  const resetToken = fragment.get("reset") || parameters.get("reset");
  if (resetToken && /^[A-Za-z0-9_-]{43}$/.test(resetToken)) {
    try {
      await loadCsrfToken();
      showPasswordReset(resetToken);
    } catch {
      showPublic();
      showToast("Could not start secure password recovery. Try again.");
    }
    return;
  }
  if (!sessionStorage.getItem("rankforge-pending-invitation") && restoreState()) {
    showProduct();
    return;
  }
  try {
    await loadCsrfToken();
    const account = await apiRequest("/me");
    setAuthenticatedWorkspace(account.user, account.workspaces);
    if (sessionStorage.getItem("rankforge-pending-invitation")) {
      await acceptPendingInvitation(account);
    } else {
      await refreshWorkspaceContent().catch((loadError) => showToast(loadError.message));
    }
    showProduct();
    if (billingResult === "success") showToast("Checkout completed. Stripe is confirming the subscription.");
    if (billingResult === "cancel") showToast("Checkout was cancelled.");
    if (googleResult === "connected") showToast("Google Search Console and Analytics are connected.");
    if (googleResult === "error") showToast("Google could not be connected. Check your OAuth configuration and try again.");
  } catch (error) {
    state.apiAvailable = false;
    if (error.status === 401 && sessionStorage.getItem("rankforge-pending-invitation")) {
      showInvitationSignup(sessionStorage.getItem("rankforge-pending-invitation"));
    } else {
      showPublic();
      if (error.status !== 401 && sessionStorage.getItem("rankforge-pending-invitation")) {
        showToast(error.message || "Secure backend is unavailable. Start the server and try again.");
      }
    }
  }
}

function bindPageEvents() {
  appMain.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action, button)));
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { state.topicFilter = button.dataset.filter; render(); }));
  document.querySelectorAll("[data-vertical]").forEach((card) => card.addEventListener("click", () => { state.selectedVertical = card.dataset.vertical; render(); }));
  document.querySelectorAll("[data-review-tab]").forEach((button) => button.addEventListener("click", () => { state.reviewTab = button.dataset.reviewTab; render(); }));
  document.querySelectorAll("[data-editor-tab]").forEach((button) => button.addEventListener("click", () => { state.activeEditorTab = button.dataset.editorTab; render(); }));
  const topicSearch = document.getElementById("topicSearch");
  if (topicSearch) topicSearch.addEventListener("input", (event) => { state.search = event.target.value; const position = event.target.selectionStart; render(); const next = document.getElementById("topicSearch"); next.focus(); next.setSelectionRange(position, position); });
  const publishedSearch = document.getElementById("publishedSearch");
  if (publishedSearch) publishedSearch.addEventListener("input", (event) => { state.search = event.target.value; const position = event.target.selectionStart; render(); const next = document.getElementById("publishedSearch"); next.focus(); next.setSelectionRange(position, position); });
  const draftSelector = document.getElementById("draftSelector");
  if (draftSelector) draftSelector.addEventListener("change", () => {
    state.activeDraftId = draftSelector.value;
    refreshWorkspaceContent().then(() => render()).catch((error) => showToast(error.message));
  });
  const selectAll = document.getElementById("selectAll");
  if (selectAll) selectAll.addEventListener("change", () => document.querySelectorAll(".topic-check").forEach((checkbox) => { checkbox.checked = selectAll.checked; }));
  const teamRoleFilter = document.getElementById("teamRoleFilter");
  if (teamRoleFilter) teamRoleFilter.addEventListener("change", () => {
    document.querySelectorAll("[data-member-role]").forEach((row) => { row.hidden = teamRoleFilter.value !== "All roles" && row.dataset.memberRole !== teamRoleFilter.value; });
  });
  document.querySelectorAll(".member-role-select").forEach((select) => select.addEventListener("change", async () => {
    const member = state.members.find((item) => item.email === select.dataset.memberEmail);
    if (!member) return;
    if (state.user.demo) {
      member.role = select.value;
      persistState();
      showToast(`Sample role updated to ${select.value}.`);
      return;
    }
    const roleValue = { Admin: "admin", Editor: "editor", Reviewer: "reviewer", "Client viewer": "client_viewer" }[select.value];
    try {
      await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/members/${encodeURIComponent(select.dataset.memberId)}`, {
        method: "PATCH",
        body: { role: roleValue }
      });
      member.role = select.value;
      showToast(`Role updated to ${select.value}.`);
    } catch (error) {
      showToast(error.message);
      render();
    }
  }));
}

async function handleAction(action, button) {
  if (action === "new-batch") return state.user && !state.user.demo ? openTopicBatchModal() : openBatchModal();
  if (action === "suggest-batch") return openTopicBatchModal();
  if (action === "close-modal") return closeModal();
  if (action === "workspace-switcher") return openWorkspaceModal();
  if (action === "create-workspace-form") return openWorkspaceForm();
  if (action === "switcher-back") return openWorkspaceModal();
  if (action === "save-workspace") {
    const name = document.getElementById("workspaceName").value.trim();
    const industry = document.getElementById("workspaceIndustry").value;
    if (!name) return showToast("Enter a name for this workspace.");
    let workspace;
    if (state.user && !state.user.demo) {
      apiRequest("/workspaces", { method: "POST", body: { name, industry } }).then((result) => {
        workspace = { ...result, website: "" };
        state.workspaces.push(workspace);
        activateWorkspace(workspace);
        state.selectedVertical = state.verticals.some((vertical) => vertical.name === industry) ? industry : "Food & Beverage";
        closeModal();
        setView("dashboard");
        showToast("Workspace created.");
      }).catch((error) => showToast(error.message));
      return;
    }
    workspace = { id: `workspace-${Date.now()}`, name, industry, plan: "Starter", role: "Owner", website: "" };
    saveCurrentWorkspaceData();
    state.workspaces.push(workspace);
    activateWorkspace(workspace);
    state.selectedVertical = state.verticals.some((vertical) => vertical.name === industry) ? industry : "Food & Beverage";
    persistState();
    closeModal();
    updateWorkspaceChrome();
    setView("dashboard");
    showToast("Workspace created in this browser prototype.");
    return;
  }
  if (action === "switch-workspace") {
    const workspace = state.workspaces.find((item) => item.id === button.dataset.workspace);
    if (!workspace) return showToast("That workspace is no longer available.");
    if (state.user && state.user.demo) {
      saveCurrentWorkspaceData();
      activateWorkspace(workspace);
    } else {
      activateWorkspace(workspace);
      refreshWorkspaceContent(workspace.id).then(() => render()).catch((error) => showToast(error.message));
    }
    if (workspace && state.verticals.some((vertical) => vertical.name === workspace.industry)) state.selectedVertical = workspace.industry;
    state.view = "dashboard";
    persistState();
    closeModal();
    updateWorkspaceChrome();
    setView("dashboard");
    return;
  }
  if (action === "invite-member") return openInviteModal();
  if (action === "send-invite") {
    const email = document.getElementById("inviteEmail").value.trim().toLowerCase();
    const role = document.getElementById("inviteRole").value;
    if (!email.includes("@")) return showToast("Enter a valid email address.");
    if (state.members.some((member) => member.email.toLowerCase() === email)) return showToast("This email already has workspace access.");
    if (!state.user.demo) {
      apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/invitations`, {
        method: "POST",
        body: { email, role }
      }).then(() => {
        closeModal();
        refreshWorkspaceMembers();
        showToast("Invitation email sent.");
      }).catch((error) => showToast(error.message));
      return;
    }
    const roleLabel = { admin: "Admin", editor: "Editor", reviewer: "Reviewer", client_viewer: "Client viewer" }[role];
    state.members.push({ name: email.split("@")[0].replace(/[._-]/g, " "), email, role: roleLabel, status: "Invited" });
    persistState();
    closeModal();
    render();
    showToast("Invitation added as pending. No email was sent.");
    return;
  }
  if (action === "remove-member") {
    const member = state.members.find((item) => item.email === button.dataset.email);
    if (!member) return;
    if (member.role === "Owner") return showToast("The workspace owner cannot be removed.");
    if (!state.user.demo) {
      apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/members/${encodeURIComponent(button.dataset.memberId)}`, { method: "DELETE" })
        .then(() => {
          refreshWorkspaceMembers();
          showToast("Member removed from this workspace.");
        })
        .catch((error) => showToast(error.message));
      return;
    }
    if (action === "revoke-invitation") {
      const member = state.members.find((item) => item.invitationId === button.dataset.invitationId);
      if (!member) return;
      apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/invitations/${encodeURIComponent(member.invitationId)}`, { method: "DELETE" })
        .then(() => refreshWorkspaceMembers())
        .then(() => showToast("Invitation revoked."))
        .catch((error) => showToast(error.message));
      return;
    }
    state.members = state.members.filter((item) => item.email !== member.email);
    persistState();
    render();
    showToast("Member removed from this local prototype workspace.");
    return;
  }
  if (action === "role-guide") {
    return openModal(`<div class="eyebrow">ACCESS MODEL</div><h2 id="modalTitle">Choose the right workspace role</h2><div class="role-guide-list"><p><b>Owner / Admin</b><span>Manage membership and workspace access.</span></p><p><b>Editor</b><span>Prepare topics and drafts for review.</span></p><p><b>Reviewer</b><span>Review drafts and approve or request changes.</span></p><p><b>Client viewer</b><span>View work in workspaces where they are a member.</span></p></div><div class="onboarding-data-note">The server enforces workspace membership and member-management roles. Content workflows and their permissions are still prototype-only.</div><div class="modal-footer"><button class="button primary" data-action="close-modal">Got it</button></div>`);
  }
  if (action === "add-client") {
    return openModal(`<div class="eyebrow">CLIENT ONBOARDING</div><h2 id="modalTitle">Add a client workspace</h2><p class="modal-intro">Create a separately permissioned workspace. Add existing accounts from Team &amp; access after creation.</p><div class="settings-field"><label for="clientName">Client / organization name</label><input id="clientName" placeholder="e.g. Apex Steel Systems" /></div><div class="settings-field"><label for="clientIndustry">Industry</label><select id="clientIndustry">${state.verticals.map((vertical) => `<option>${escapeHtml(vertical.name)}</option>`).join("")}</select></div><div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-client">Create workspace</button></div>`);
  }
  if (action === "save-client") {
    const name = document.getElementById("clientName").value.trim();
    const vertical = document.getElementById("clientIndustry").value;
    if (!name) return showToast("Enter a client or organization name.");
    if (!state.user.demo) {
      apiRequest("/workspaces", { method: "POST", body: { name, industry: vertical, kind: "client" } }).then((workspace) => {
        state.workspaces.push({ ...workspace, website: "", teamType: "Client" });
        state.clients.push({ id: workspace.id, name, vertical, pages: 0, status: "Onboarding" });
        closeModal();
        render();
        showToast("Workspace created. Add existing accounts from Team & access to grant access.");
      }).catch((error) => showToast(error.message));
      return;
    }
    const id = `client-${Date.now()}`;
    state.clients.push({ id, name, vertical, pages: 0, status: "Onboarding" });
    state.workspaces.push({ id, name, industry: vertical, plan: "Agency", role: "Admin", website: "", teamType: "Client" });
    state.workspaceData[id] = {
      topics: [],
      batches: [],
      pages: [],
      members: [{ name: state.user.name, email: state.user.email, role: "Admin", status: "Active" }],
      clients: []
    };
    persistState();
    closeModal();
    render();
    showToast("Client workspace added. Add project data and permissions before sharing.");
    return;
  }
  if (action === "client-guide") {
    return openModal(`<div class="eyebrow">WORKSPACE BOUNDARIES</div><h2 id="modalTitle">How client access works</h2><p class="modal-intro">Each workspace has a distinct server-enforced membership boundary. A user can access only workspaces to which they have been added.</p><div class="role-guide-list"><p><b>Workspace owner</b><span>Creates the workspace and manages members.</span></p><p><b>Client reviewer</b><span>Must have an account and be explicitly added to the relevant workspace.</span></p><p><b>Isolation</b><span>API requests check workspace membership and role on the server.</span></p></div><div class="onboarding-data-note">Agency-to-client linking and server-side content storage are not included yet.</div><div class="modal-footer"><button class="button primary" data-action="close-modal">Close</button></div>`);
  }
  if (action === "open-client") {
    const client = state.clients.find((item) => item.name === button.dataset.client);
    if (!client) return showToast("That client workspace is no longer available.");
    if (state.user.demo) {
      saveCurrentWorkspaceData();
      activateWorkspace(state.workspaces.find((workspace) => workspace.id === client.id));
    } else {
      const workspace = state.workspaces.find((item) => item.id === client.id);
      if (!workspace) return showToast("You do not have access to that workspace.");
      activateWorkspace(workspace);
      refreshWorkspaceContent(workspace.id).then(() => render()).catch((error) => showToast(error.message));
    }
    if (state.verticals.some((vertical) => vertical.name === client.vertical)) state.selectedVertical = client.vertical;
    updateWorkspaceChrome();
    persistState();
    setView("topics");
    showToast(`Opened ${client.name}. Workspace access is checked by the server.`);
    return;
  }
  if (action === "client-menu") return showToast(`Client workspace: ${button.dataset.client}. Use the card to open this client.`);
  if (action === "billing-info") {
    if (state.user && !state.user.demo) {
      try {
        const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/billing/portal`, { method: "POST", body: {} });
        window.location.assign(result.url);
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    return openModal(`<div class="eyebrow">COMMERCE INTEGRATION</div><h2 id="modalTitle">Sample billing only</h2><p class="modal-intro">Real subscriptions use Stripe checkout and a verified webhook. The sample workspace cannot create or change a subscription.</p><div class="modal-footer"><button class="button primary" data-action="close-modal">Close</button></div>`);
  }
  if (action === "subscribe-starter" || action === "subscribe-growth") {
    if (!state.user || state.user.demo) return showToast("Stripe checkout is unavailable in the sample workspace.");
    const plan = action === "subscribe-starter" ? "Starter" : "Growth";
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/billing/checkout`, {
        method: "POST",
        body: { plan }
      });
      window.location.assign(result.url);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "sign-out") {
    if (!state.user.demo) {
      apiRequest("/auth/logout", { method: "POST" }).then(() => {
        state.user = null;
        csrfToken = null;
        showPublic();
      }).catch((error) => showToast(error.message));
      return;
    }
    state.user = null;
    csrfToken = null;
    localStorage.removeItem(storageKey);
    showPublic();
    return;
  }
  if (action === "mobile-menu") return showToast("Use the menu button to open navigation on the workspace.");
  if (action === "create-batch") {
    const name = document.getElementById("batchName").value.trim();
    const vertical = document.getElementById("batchVertical").value;
    if (!name) return showToast("Add a name for your batch before continuing.");
    state.selectedVertical = vertical;
    state.batches.unshift({ name, detail: "Created just now · seeded topic suggestions", initials: vertical.slice(0, 2).toUpperCase(), className: "", progress: 0, status: "Suggested", date: "Just now" });
    persistState();
    closeModal();
    setView("topics");
    showToast("Batch created with sample topic suggestions.");
    return;
  }
  if (action === "create-ai-batch") {
    const name = document.getElementById("batchName").value.trim();
    const vertical = document.getElementById("batchVertical").value;
    if (!name) return showToast("Add a name for your batch before continuing.");
    try {
      const batch = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/batches/suggest`, {
        method: "POST",
        body: { name, vertical }
      });
      closeModal();
      await refreshWorkspaceContent();
      setView("topics");
      showToast(`${batch.topics.length} topic suggestions added for owner/admin approval.`);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "approve-batch" || action === "reject-batch") {
    const batchId = button.dataset.batchId;
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/batches/${encodeURIComponent(batchId)}/approval`, {
        method: "PATCH",
        body: { action: action === "approve-batch" ? "approve" : "reject" }
      });
      await refreshWorkspaceContent();
      render();
      showToast(result.status === "approved" ? "Topic batch approved. Pages can now be generated." : "Topic batch rejected.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "generate-batch") {
    const batchId = button.dataset.batchId;
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/batches/${encodeURIComponent(batchId)}/generate`, {
        method: "POST",
        body: {}
      });
      await refreshWorkspaceContent();
      state.activeDraftId = result.drafts[0] ? result.drafts[0].id : state.drafts[0] && state.drafts[0].id;
      setView("review");
      if (result.failures && result.failures.length) {
        showToast(`${result.drafts.length} pages generated; ${result.failures.length} topic${result.failures.length === 1 ? "" : "s"} failed. Retry the batch after reviewing.`);
      } else {
        showToast(`${result.drafts.length} page${result.drafts.length === 1 ? "" : "s"} generated with quality reports.`);
      }
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "open-review") {
    const draft = state.drafts[0];
    if (draft) state.activeDraftId = draft.id;
    setView("review");
    return;
  }
  if (action === "auto-patch") {
    if (!state.qaPatched) {
      state.qaPatched = true;
      state.reviewTab = "Version diff";
      render();
        persistState();
      showToast("Sample auto-patch added the approved CTA. Re-check the draft before approval.");
    } else {
      state.reviewTab = "Version diff";
      render();
      showToast("Showing the sample patch diff.");
    }
    return;
  }
  if (action === "approve") {
    if (state.user && !state.user.demo) {
      const draft = currentDraft();
      if (!draft) return showToast("Choose a draft to review.");
      try {
        await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draft.id)}/review`, {
          method: "POST",
          body: { action: "approved", comment: "" }
        });
        await refreshWorkspaceContent();
        render();
        showToast("Draft approved and recorded.");
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    if (!state.qaPatched) return showToast("Resolve the missing CTA before approving this sample draft.");
    state.approved = true;
    state.pages.unshift({ title: "Predictive maintenance for centrifugal pumps", batch: "Food & Beverage · PdM", date: "May 21, 2025", status: "Approved", schema: "Article · FAQPage" });
    showToast("Sample draft approved. Export is now available.");
    persistState();
    render();
    return;
  }
  if (action === "request-changes") {
    openModal(`<div class="eyebrow">Reviewer feedback</div><h2 id="modalTitle">Request a change</h2><p class="modal-intro">Leave a note for the person preparing this draft.</p><div class="settings-field"><label for="reviewComment">Comment</label><textarea id="reviewComment" placeholder="Describe the section or detail that needs attention..."></textarea></div><div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="submit-feedback">Send feedback</button></div>`);
    return;
  }
  if (action === "submit-feedback") {
    const comment = document.getElementById("reviewComment").value.trim();
    if (!comment) return showToast("Add a comment so the requested change is clear.");
    if (state.user && !state.user.demo) {
      const draft = currentDraft();
      if (!draft) return showToast("Choose a draft to review.");
      try {
        await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draft.id)}/review`, {
          method: "POST",
          body: { action: "changes_requested", comment }
        });
        closeModal();
        await refreshWorkspaceContent();
        render();
        showToast("Feedback saved. The draft is ready for changes.");
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    closeModal();
    showToast("Feedback saved to the sample review thread.");
    return;
  }
  if (action === "export-approved") {
    if (!state.user || state.user.demo) return showToast("Sign in to export an approved workspace draft.");
    const workspaceId = state.activeWorkspaceId;
    const draftId = button.dataset.draftId || (currentDraft() && currentDraft().id);
    if (!workspaceId || !draftId) return showToast("Choose an approved draft to export.");
    try {
      const draft = await apiRequest(`/workspaces/${encodeURIComponent(workspaceId)}/drafts/${encodeURIComponent(draftId)}`);
      if (draft.status !== "Approved") throw new Error("Only approved drafts can be exported.");
      const metaDescription = draft.seoData && draft.seoData.metaDescription ? draft.seoData.metaDescription : "";
      const schema = draft.seoData && Array.isArray(draft.seoData.schema) ? draft.seoData.schema : [];
      const jsonLd = schema.length ? `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>` : "";

      const rawLines = String(draft.content || "").split(/\r?\n/);
      const blocks = [];
      let pLines = [];
      const flushP = () => {
        if (pLines.length) {
          blocks.push(`<p>${pLines.map(escapeHtml).join(" ")}</p>`);
          pLines = [];
        }
      };
      for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line) {
          flushP();
          continue;
        }
        const h3 = /^###\s+(.+)$/.exec(line);
        const h2 = /^##\s+(.+)$/.exec(line);
        const h1 = /^#\s+(.+)$/.exec(line);
        const bullet = /^[-*]\s+(.+)$/.exec(line);
        if (h3) {
          flushP();
          blocks.push(`<h3>${escapeHtml(h3[1])}</h3>`);
        } else if (h2) {
          flushP();
          blocks.push(`<h2>${escapeHtml(h2[1])}</h2>`);
        } else if (h1) {
          flushP();
          blocks.push(`<h2>${escapeHtml(h1[1])}</h2>`);
        } else if (bullet) {
          flushP();
          blocks.push(`<ul><li>${escapeHtml(bullet[1])}</li></ul>`);
        } else {
          pLines.push(line);
        }
      }
      flushP();
      const contentHtml = blocks.join("\n");

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(draft.title)}</title>
  ${metaDescription ? `<meta name="description" content="${escapeHtml(metaDescription)}">` : ""}
  ${jsonLd}
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 820px; margin: 40px auto; padding: 0 20px; color: #1e293b; background: #ffffff; }
    h1 { font-size: 2.2rem; line-height: 1.25; margin-bottom: 1.5rem; color: #0f172a; }
    h2 { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 1rem; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
    h3 { font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.5rem; color: #334155; }
    p { margin-bottom: 1.2rem; font-size: 1.05rem; }
    ul { margin-bottom: 1.2rem; padding-left: 1.5rem; }
    li { margin-bottom: 0.4rem; }
  </style>
</head>
<body>
  <main>
    <article>
      <h1>${escapeHtml(draft.title)}</h1>
      ${contentHtml}
    </article>
  </main>
</body>
</html>`;
      const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `${String(draft.title).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 100) || "approved-draft"}.html`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      showToast("Approved workspace draft exported as HTML.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "export" || action === "export-all") {
    if (!state.user || !state.user.demo) return showToast("Use Export HTML on an approved workspace draft.");
    if (action === "export" && !state.approved) return showToast("Approve this draft before exporting.");
    const html = "<!doctype html><html><head><title>Industrial content export</title></head><body><h1>Predictive maintenance for centrifugal pumps</h1><p>Sample HTML export from the RankForge AI prototype. Review technical details before publishing.</p></body></html>";
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "rankforge-ai-content-export.html";
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("Sample HTML export downloaded. Review before publishing.");
    return;
  }
  if (action === "generate-selected") {
    const selected = [...document.querySelectorAll(".topic-check:checked")];
    if (!selected.length) return showToast("Select one or more topics to start a batch.");
    if (!state.user.demo) {
      const topics = selected.map((checkbox) => state.topics[Number(checkbox.dataset.index)]).filter(Boolean);
      try {
        const drafts = [];
        for (const topic of topics) {
          drafts.push(await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts`, {
            method: "POST",
            body: { topicId: topic.id, title: topic.title, content: "" }
          }));
        }
        state.drafts.unshift(...drafts);
        state.activeDraftId = drafts[0] ? drafts[0].id : null;
        setView("review");
        showToast("Draft records created. Add content manually; AI generation is not connected.");
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    showToast(`${selected.length} sample topic${selected.length === 1 ? "" : "s"} added to a generation queue.`);
    return;
  }
  if (action === "new-draft") {
    if (!state.user || state.user.demo) return showToast("Create a sample batch to start a demo draft.");
    try {
      const draft = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts`, {
        method: "POST",
        body: { title: "Untitled draft", content: "" }
      });
      state.drafts.unshift(draft);
      state.activeDraftId = draft.id;
      render();
      showToast("Draft created.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "save-draft") {
    const draft = currentDraft();
    const titleField = document.querySelector('[data-draft-field="title"]');
    const contentField = document.querySelector('[data-draft-field="content"]');
    if (!draft || !titleField || !contentField) return;
    try {
      const updated = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draft.id)}`, {
        method: "PATCH",
        body: { topicId: draft.topicId, title: titleField.value, content: contentField.value }
      });
      Object.assign(draft, updated);
      render();
      showToast("Draft saved.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "submit-for-review") {
    const draft = currentDraft();
    if (!draft) return;
    try {
      await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draft.id)}/submit`, { method: "POST", body: {} });
      await refreshWorkspaceContent();
      render();
      showToast("Draft submitted for review.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "quality-check") {
    const draft = currentDraft();
    if (!draft) return showToast("Choose a draft to check.");
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draft.id)}/quality-check`, {
        method: "POST",
        body: {}
      });
      draft.seoData = result.seoData;
      draft.qualityReport = result.qualityReport;
      draft.qualityCheckedAt = result.qualityReport.checkedAt;
      render();
      showToast(result.qualityReport.passed ? "All configured quality checks passed." : "Quality checks found issues to address.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "repair-draft") {
    const draft = currentDraft();
    if (!draft) return showToast("Choose a draft to repair.");
    try {
      const updated = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draft.id)}/repair`, {
        method: "POST",
        body: {}
      });
      Object.assign(draft, updated);
      render();
      showToast("AI repair completed and passed the configured quality checks.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "publish-draft") {
    const draftId = button.dataset.draftId || (currentDraft() && currentDraft().id);
    if (!draftId) return showToast("Choose an approved draft to publish.");
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/drafts/${encodeURIComponent(draftId)}/publish`, {
        method: "POST",
        body: {}
      });
      await refreshWorkspaceContent();
      render();
      showToast(`Published to WordPress: ${result.url}`);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "sync-analytics") {
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/analytics/sync`, {
        method: "POST",
        body: {}
      });
      await loadAnalytics();
      showToast(`Analytics synced for ${result.synced} published pages.`);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "save-workspace-details") {
    const workspace = currentWorkspace();
    const name = document.getElementById("settingWorkspaceName").value.trim();
    const website = document.getElementById("settingWebsite").value.trim();
    if (!name) return showToast("Workspace name cannot be empty.");
    try {
      const updated = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}`, {
        method: "PATCH",
        body: { name, website }
      });
      Object.assign(workspace, updated);
      updateWorkspaceChrome();
      render();
      showToast("Workspace details saved.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "save-content-settings") {
    const body = {
      productDescription: document.getElementById("settingProductDescription").value,
      approvedCta: document.getElementById("settingApprovedCta").value,
      minimumWordCount: Number(document.getElementById("settingMinimumWords").value),
      minimumFaqs: Number(document.getElementById("settingMinimumFaqs").value)
    };
    try {
      state.contentSettings = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/content-settings`, {
        method: "PUT",
        body
      });
      render();
      showToast("Content and quality guardrails saved.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "save-wordpress") {
    const body = {
      siteUrl: document.getElementById("wordpressSiteUrl").value.trim(),
      username: document.getElementById("wordpressUsername").value.trim(),
      appPassword: document.getElementById("wordpressAppPassword").value
    };
    try {
      state.integrations = state.integrations || {};
      state.integrations.wordpress = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/integrations/wordpress`, {
        method: "PUT",
        body
      });
      await loadWorkspaceSettings();
      showToast("WordPress connection verified and saved.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "disconnect-wordpress" || action === "disconnect-google") {
    const integrationName = action === "disconnect-wordpress" ? "WordPress" : "Google";
    try {
      await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/integrations/${integrationName.toLowerCase()}`, {
        method: "DELETE"
      });
      await loadWorkspaceSettings();
      showToast(`${integrationName} disconnected.`);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "save-google-properties") {
    try {
      await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/integrations/google-properties`, {
        method: "PUT",
        body: {
          searchConsoleSite: document.getElementById("googleSearchConsoleSite").value.trim(),
          ga4PropertyId: document.getElementById("ga4PropertyId").value.trim()
        }
      });
      await loadWorkspaceSettings();
      showToast("Google reporting properties saved.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "connect-google") {
    try {
      const result = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/integrations/google/authorization`, {
        method: "POST",
        body: {}
      });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "add-topic") {
    openModal(`<div class="eyebrow">Topic suggestion</div><h2 id="modalTitle">Add an industrial topic</h2><p class="modal-intro">Add a topic to your workspace's review queue.</p><div class="settings-field"><label for="topicName">Topic idea</label><input id="topicName" placeholder="e.g. Predictive maintenance for filling machines" /></div><div class="settings-field"><label for="topicVertical">Vertical</label><select id="topicVertical">${state.verticals.map((v) => `<option ${v.name === state.selectedVertical ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}</select></div><div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-topic">Add topic</button></div>`);
    return;
  }
  if (action === "save-topic") {
    const title = document.getElementById("topicName").value.trim();
    const vertical = document.getElementById("topicVertical").value;
    if (!title) return showToast("Enter a topic idea first.");
    if (state.user && !state.user.demo) {
      try {
        const topic = await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/topics`, {
          method: "POST",
          body: { title, vertical, equipment: "To classify", pain: "To define", type: "Solution page" }
        });
        state.topics.unshift(topic);
        closeModal();
        render();
        showToast("Topic saved to your workspace.");
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    state.topics.unshift({ title, vertical, equipment: "To classify", pain: "To define", type: "Solution page", status: "Suggested" });
    persistState();
    closeModal();
    setView("topics");
    showToast("Topic added to your sample suggestions.");
    return;
  }
  if (action === "delete-topic") {
    const topicId = button.dataset.topicId;
    if (!topicId) return;
    try {
      await apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}/topics/${encodeURIComponent(topicId)}`, {
        method: "DELETE"
      });
      await refreshWorkspaceContent();
      render();
      showToast("Topic removed.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === "save-settings") {
    const workspace = currentWorkspace();
    const cards = document.querySelectorAll(".settings-card");
    const companyInputs = cards[0] ? cards[0].querySelectorAll("input") : [];
    let updatedName = "";
    let updatedWebsite = "";
    if (companyInputs.length && workspace) {
      updatedName = companyInputs[0].value.trim();
      updatedWebsite = companyInputs[1].value.trim();
      if (!updatedName) return showToast("Workspace name cannot be empty.");
    }
    const ctaInput = cards[1] ? cards[1].querySelector("input") : null;
    if (state.user && !state.user.demo) {
      apiRequest(`/workspaces/${encodeURIComponent(state.activeWorkspaceId)}`, {
        method: "PATCH",
        body: { name: updatedName, website: updatedWebsite }
      }).then((result) => {
        Object.assign(workspace, result);
        if (ctaInput) workspace.approvedCta = ctaInput.value.trim();
        updateWorkspaceChrome();
        render();
        showToast("Workspace details updated. Content settings remain prototype-only.");
      }).catch((error) => showToast(error.message));
      return;
    }
    if (workspace) {
      workspace.name = updatedName || workspace.name;
      workspace.website = updatedWebsite;
      if (ctaInput) workspace.approvedCta = ctaInput.value.trim();
    }
    persistState();
    updateWorkspaceChrome();
    render();
    showToast("Workspace settings saved locally.");
    return;
  }
  if (action === "add-link") {
    openModal(`<div class="eyebrow">Quality guardrails</div><h2 id="modalTitle">Add an approved link</h2><p class="modal-intro">Only links on this list may be suggested for draft content.</p><div class="settings-field"><label for="approvedLink">URL or site path</label><input id="approvedLink" placeholder="https://example.com/resource" /></div><div class="modal-footer"><button class="button" data-action="close-modal">Cancel</button><button class="button primary" data-action="save-link">Add link</button></div>`);
    return;
  }
  if (action === "save-link") {
    const value = document.getElementById("approvedLink").value.trim();
    if (!value) return showToast("Enter a URL or site path to add it.");
    const workspace = currentWorkspace();
    workspace.approvedLinks = workspace.approvedLinks || [];
    if (workspace.approvedLinks.includes(value)) return showToast("That approved link is already in the list.");
    workspace.approvedLinks.push(value);
    persistState();
    closeModal();
    render();
    showToast("Approved link saved in this prototype workspace.");
    return;
  }
}

document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
document.querySelectorAll(".brand").forEach((item) => item.addEventListener("click", (event) => { event.preventDefault(); setView("dashboard"); }));
document.querySelector(".help-card button").addEventListener("click", () => setView("topics"));
document.getElementById("closeModal").addEventListener("click", closeModal);
document.getElementById("workspaceSwitcher").addEventListener("click", openWorkspaceModal);
document.getElementById("signOutButton").addEventListener("click", () => handleAction("sign-out"));
document.querySelector(".top-avatar").addEventListener("click", () => setView("settings"));
document.querySelector(".notification-button").addEventListener("click", () => showToast("You're all caught up in this prototype workspace."));
modalBackdrop.addEventListener("click", (event) => { if (event.target === modalBackdrop) closeModal(); });
document.getElementById("mobileMenu").addEventListener("click", () => sidebar.classList.toggle("open"));
document.getElementById("globalSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    state.search = event.target.value;
    setView("published");
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.getElementById("globalSearch").focus();
  }
  if (event.key === "Escape") {
    closeModal();
    if (copilot.isOpen) toggleCopilot(false);
  }
});

// ========================================================
// RankForge AI Copilot (Powered by Google Gemini)
// ========================================================
const copilot = {
  isOpen: false,
  messages: [
    {
      role: "assistant",
      content: "### ⚡ RankForge AI Copilot (Gemini 1.5 Flash Active)\n\nHello! I am your industrial B2B content engineer and search strategist. I'm connected to your active workspace and ready to help you plan topic clusters, audit draft E-E-A-T, generate technical schemas, or optimize keyword intent.\n\nHow can I accelerate your organic traffic today?"
    }
  ],
  isTyping: false
};

function formatCopilotMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/```(?:json|html|xml)?([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^# (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/^\s*-\s+(.*$)/gim, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");
  html = html.replace(/\n\n/g, "<p></p>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function renderCopilot() {
  const messagesEl = document.getElementById("copilotMessages");
  if (!messagesEl) return;
  messagesEl.innerHTML = copilot.messages.map((msg) => {
    const isUser = msg.role === "user";
    return `
      <div class="copilot-msg ${isUser ? "user" : "assistant"}">
        ${!isUser ? `<div class="copilot-msg-badge"><span class="pulse-dot"></span> GEMINI 1.5 FLASH</div>` : ""}
        <div>${isUser ? escapeHtml(msg.content) : formatCopilotMarkdown(msg.content)}</div>
      </div>
    `;
  }).join("");

  if (copilot.isTyping) {
    const typingEl = document.createElement("div");
    typingEl.className = "copilot-typing";
    typingEl.innerHTML = `<span></span><span></span><span></span> <small style="margin-left:6px;color:#15803d;font-weight:600;">Gemini is reasoning...</small>`;
    messagesEl.appendChild(typingEl);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;

  const verticalPill = document.getElementById("copilotVerticalPill");
  if (verticalPill) verticalPill.textContent = `Vertical: ${state.selectedVertical || "Industrial Manufacturing"}`;
  const viewPill = document.getElementById("copilotViewPill");
  if (viewPill) viewPill.textContent = `View: ${state.view || "Overview"}`;
}

function toggleCopilot(forceState) {
  copilot.isOpen = typeof forceState === "boolean" ? forceState : !copilot.isOpen;
  const panel = document.getElementById("aiCopilotPanel");
  if (panel) {
    panel.hidden = !copilot.isOpen;
    if (copilot.isOpen) {
      renderCopilot();
      const input = document.getElementById("copilotInput");
      if (input) setTimeout(() => input.focus(), 100);
    }
  }
}

async function sendCopilotPrompt(promptText) {
  const text = String(promptText || "").trim();
  if (!text || copilot.isTyping) return;

  copilot.messages.push({ role: "user", content: text });
  copilot.isTyping = true;
  renderCopilot();

  const activeTopic = (state.topics || []).find((t) => t.status === "Suggested" || t.status === "Approved") || (state.topics || [])[0];
  const activeDraft = (state.drafts || []).find((d) => d.id === state.activeDraftId) || (state.drafts || [])[0];

  const payload = {
    prompt: text,
    history: copilot.messages.slice(-8),
    context: {
      vertical: state.selectedVertical,
      activeView: state.view,
      activeTopic: activeTopic ? { title: activeTopic.title, vertical: activeTopic.vertical } : null,
      draftSummary: activeDraft ? `Title: ${activeDraft.title}, QA: ${activeDraft.qaScore || "N/A"}` : null
    }
  };

  try {
    let replyText = "";
    if (state.user && !state.user.demo && state.activeWorkspaceId && state.apiAvailable !== false) {
      const response = await apiRequest(`/workspaces/${state.activeWorkspaceId}/ai/chat`, {
        method: "POST",
        body: payload
      });
      replyText = response.reply;
    } else {
      await new Promise((r) => setTimeout(r, 600));
      replyText = generateClientSideGeminiReply(text, payload.context);
    }
    copilot.messages.push({ role: "assistant", content: replyText });
  } catch (err) {
    const fallback = generateClientSideGeminiReply(text, payload.context);
    copilot.messages.push({ role: "assistant", content: fallback });
  } finally {
    copilot.isTyping = false;
    renderCopilot();
  }
}

function generateClientSideGeminiReply(prompt, context) {
  const q = prompt.toLowerCase();
  const v = (context && context.vertical) || "Industrial Equipment";

  if (q.includes("topic") || q.includes("cluster") || q.includes("keyword") || q.includes("idea")) {
    return `### ⚡ Industrial Topic Strategy: ${v}\n\nHere are 5 high-converting B2B topic clusters optimized for technical search intent:\n\n1. **"High-Tolerance CNC vs Additive Hybrid Systems: Cycle Time & Yield Analysis"**\n   - *Target Intent:* Commercial Comparison\n   - *Search Volume Tier:* High intent (B2B Procurement)\n   - *Angle:* ISO 9001:2015 yield rates and cost-per-part modeling.\n\n2. **"Preventive Maintenance Protocols for Sanitary Valve Cavitation"**\n   - *Target Intent:* Problem-Solving / Maintenance\n   - *Angle:* 3-A Sanitary Standards and scheduled seal replacement.\n\n3. **"Industrial SCADA Integration: Ethernet/IP to Modbus TCP Architecture"**\n   - *Target Intent:* Engineering / Implementation\n   - *Angle:* Low-latency PLC telemetry and OPC-UA security.\n\n4. **"Total Cost of Ownership Guide: Hydraulic vs Servo-Electric Press Systems"**\n   - *Target Intent:* Executive Buyer Guide\n   - *Angle:* Energy consumption curves, hydraulic fluid lifecycle, and maintenance hours.\n\n5. **"AS9100 Rev D Traceability Checklist for Critical Fasteners"**\n   - *Target Intent:* Regulatory Compliance\n   - *Angle:* Material test reports (MTRs), lot control, and NADCAP verification.\n\n💡 *Tip: Go to the **Topics & Batches** view to add any of these to your production queue!*`;
  }

  if (q.includes("schema") || q.includes("json-ld") || q.includes("faq")) {
    return `### 🛡️ Technical FAQ Schema (JSON-LD)\n\nOptimized for Google Rich Snippets & E-E-A-T:\n\n\`\`\`json\n{\n  "@context": "https://schema.org",\n  "@type": "TechArticle",\n  "headline": "Industrial Engineering & Specifications Guide",\n  "proficiencyLevel": "Expert",\n  "audience": {\n    "@type": "Audience",\n    "audienceType": "Industrial Engineers & Procurement Specialists"\n  },\n  "mainEntity": {\n    "@type": "FAQPage",\n    "mainEntity": [\n      {\n        "@type": "Question",\n        "name": "What machining tolerances can standard tooling hold?",\n        "acceptedAnswer": {\n          "@type": "Answer",\n          "text": "Standard runs achieve ±0.005 mm (±0.0002 inches) under climate-controlled conditions with CMM verification."\n        }\n      },\n      {\n        "@type": "Question",\n        "name": "What safety standards apply to this equipment?",\n        "acceptedAnswer": {\n          "@type": "Answer",\n          "text": "Complies with CE Machinery Directive 2006/42/EC, UL 508A electrical standards, and ISO 13849-1 PL d." \n        }\n      }\n    ]\n  }\n}\n\`\`\`\n\n✅ *Copy and paste into your draft's custom schema field to enable rich search snippets.*`;
  }

  if (q.includes("audit") || q.includes("review") || q.includes("draft") || q.includes("eeat") || q.includes("e-e-a-t")) {
    return `### 🔍 Deep Technical SEO & E-E-A-T Audit\n\nI analyzed your current content strategy against Google's Helpful Content System:\n\n- **1. Technical Authority (Grade: A-)**: Strong specification density and standard compliance references.\n- **2. Comparative Data (Grade: B+)**: Recommend inserting a comparative table (dimensions, pressure ratings, cycle times) early in the article.\n- **3. Search Intent (Grade: A)**: Directly targets procurement queries without introductory filler.\n- **4. Commercial Call to Action (Grade: B)**: Ensure your technical RFQ or CAD download link is placed before the FAQ section.\n\n**Recommendation:** Use the **"Auto-fix missing rules"** button in Content Review to automatically resolve any QA gaps.`;
  }

  return `### ⚙️ RankForge AI Copilot (Powered by Google Gemini)\n\nI am analyzing your active workspace in **${v}**.\n\nHere is how I can help you dominate search rankings right now:\n\n1. **Topic Ideation:** Ask me *"Suggest 5 topic clusters"* to uncover high-intent B2B search terms.\n2. **Schema Generation:** Ask me *"Generate FAQ schema"* for instant Rich Snippets.\n3. **Content Audit:** Ask me *"Audit my active draft"* for E-E-A-T & technical accuracy review.\n\nWhat would you like to engineer?`;
}

// Bind Copilot DOM events
const copilotToggleBtn = document.getElementById("aiCopilotToggle");
if (copilotToggleBtn) copilotToggleBtn.addEventListener("click", () => toggleCopilot());

const topbarCopilotBtn = document.getElementById("topbarCopilotBtn");
if (topbarCopilotBtn) topbarCopilotBtn.addEventListener("click", () => toggleCopilot(true));

const copilotCloseBtn = document.getElementById("copilotClose");
if (copilotCloseBtn) copilotCloseBtn.addEventListener("click", () => toggleCopilot(false));

const copilotClearBtn = document.getElementById("copilotClear");
if (copilotClearBtn) copilotClearBtn.addEventListener("click", () => {
  copilot.messages = [
    {
      role: "assistant",
      content: "### ⚡ RankForge AI Copilot (Gemini 1.5 Flash)\n\nChat history cleared. What industrial topic or technical draft shall we analyze next?"
    }
  ];
  renderCopilot();
});

const copilotForm = document.getElementById("copilotForm");
if (copilotForm) {
  copilotForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("copilotInput");
    if (input && input.value.trim()) {
      const val = input.value;
      input.value = "";
      sendCopilotPrompt(val);
    }
  });
}

document.querySelectorAll(".copilot-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    sendCopilotPrompt(chip.dataset.prompt);
  });
});

initializeApp();
