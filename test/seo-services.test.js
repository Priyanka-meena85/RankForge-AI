const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  autoPatchDraft,
  createOpenAIClient,
  generateTaxonomyArticle,
  suggestTaxonomyTopics,
  validateSeoDraft
} = require("../services/seo");
const { createGoogleOAuthState, createGoogleAuthorizationUrl } = require("../services/google");
const { createSecretCipher, normalizeWordPressSiteUrl } = require("../services/integrations");
const { createGeminiClient, generateContextualIndustrialResponse } = require("../services/gemini");

const goodArticle = {
  title: "Industrial pump monitoring",
  metaDescription: "Learn how industrial teams monitor pump condition and plan maintenance around production needs with a measured, practical process.",
  introduction: "A practical overview for industrial maintenance teams.",
  sections: [
    { heading: "Signals to monitor", paragraphs: ["Vibration and temperature changes can help teams investigate equipment behavior.", "Use measurements alongside operating context and manufacturer guidance."] },
    { heading: "How to plan maintenance", paragraphs: ["Review trends with operators and maintenance staff.", "Use a documented process before changing service intervals."] },
    { heading: "Getting started", paragraphs: ["Start with one equipment group and define a baseline.", "Review results before expanding the program."] }
  ],
  faqs: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index + 1}?`, answer: "A measured, documented approach helps teams evaluate the equipment in context." }))
};

function openAiResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] })
  };
}

test("OpenAI client validates structured industrial topic suggestions", async () => {
  const suggestions = Array.from({ length: 5 }, (_, index) => ({
    title: `Distinct industrial topic ${index + 1}`,
    equipment: "Industrial pump",
    pain: "Unplanned downtime",
    contentType: "Solution page"
  }));
  let request;
  const client = createOpenAIClient({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return openAiResponse({ topics: suggestions });
    }
  });
  const topics = await client.suggestTopics({
    workspace: { name: "Example", website: "", productDescription: "" },
    vertical: "Manufacturing"
  });
  assert.equal(topics.length, 5);
  assert.equal(request.model, "gpt-4.1-mini");
  assert.equal(request.response_format.json_schema.strict, true);
});

test("OpenAI article generation produces a complete structured page for QA", async () => {
  const client = createOpenAIClient({
    apiKey: "test-key",
    fetchImpl: async () => openAiResponse(goodArticle)
  });
  const article = await client.generateArticle({
    workspace: { name: "Example", industry: "Manufacturing", website: "", productDescription: "", approvedCta: "Talk to our team" },
    topic: { title: "Pump monitoring", vertical: "Manufacturing", equipment: "Industrial pump", pain: "Downtime" }
  });
  assert.match(article.body, /^A practical overview/);
  assert.match(article.body, /## Signals to monitor/);
  assert.equal(article.seoData.faqs.length, 5);
  const report = validateSeoDraft({
    title: article.title,
    body: `${article.body}\n\n${"maintenance ".repeat(700)}\n\nTalk to our team`,
    seoData: article.seoData,
    settings: { approvedCta: "Talk to our team", minimumWords: 700, minimumFaqs: 5 }
  });
  assert.equal(report.passed, true);
  assert.ok(article.seoData.schema.some((schema) => schema["@type"] === "Article"));
  assert.ok(article.seoData.schema.some((schema) => schema["@type"] === "FAQPage"));
});

test("SEO validation reports missing requirements instead of silently passing", () => {
  const report = validateSeoDraft({
    title: "Short draft",
    body: "A short draft without headings.",
    seoData: { metaDescription: "short", faqs: [], schema: [] },
    settings: { approvedCta: "Talk to our team", minimumWords: 700, minimumFaqs: 5 }
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter((check) => !check.passed).map((check) => check.id), [
    "word_count", "section_structure", "faq_count", "meta_description", "call_to_action", "structured_data"
  ]);
});

test("integration secrets use authenticated encryption and WordPress targets require HTTPS hostnames", () => {
  const key = crypto.randomBytes(32).toString("base64");
  const cipher = createSecretCipher(key);
  const encrypted = cipher.encrypt("wordpress application password");
  assert.notEqual(encrypted, "wordpress application password");
  assert.equal(cipher.decrypt(encrypted), "wordpress application password");
  assert.throws(() => cipher.decrypt(`${encrypted.slice(0, -2)}xx`));
  assert.equal(normalizeWordPressSiteUrl("https://cms.example.com"), "https://cms.example.com/");
  assert.equal(normalizeWordPressSiteUrl("http://cms.example.com"), null);
  assert.equal(normalizeWordPressSiteUrl("https://127.0.0.1"), null);
  assert.equal(normalizeWordPressSiteUrl("https://user:pass@cms.example.com"), null);
});

test("Google OAuth uses a random PKCE state and requests only reporting scopes", () => {
  const first = createGoogleOAuthState();
  const second = createGoogleOAuthState();
  assert.notEqual(first.state, second.state);
  const url = new URL(createGoogleAuthorizationUrl({
    clientId: "client-id",
    redirectUri: "https://rankforge.example/api/integrations/google/callback",
    state: first.state,
    codeChallenge: first.challenge
  }));
  assert.equal(url.searchParams.get("state"), first.state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /webmasters\.readonly/);
  assert.match(url.searchParams.get("scope"), /analytics\.readonly/);
});

test("vertical taxonomy suggestions return distinct industrial topics", () => {
  const topics = suggestTaxonomyTopics({ vertical: "Automotive", count: 8 });
  assert.equal(topics.length, 8);
  assert.ok(topics.every((t) => t.title && t.equipment && t.pain && t.contentType));
  const titles = new Set(topics.map((t) => t.title));
  assert.equal(titles.size, 8);
});

test("taxonomy article generation produces compliant structure, FAQs, and schema", () => {
  const article = generateTaxonomyArticle({
    workspace: { name: "Northstar", industry: "Automotive", approvedCta: "Schedule a plant walk" },
    topic: { title: "Robotic weld cell maintenance", equipment: "Robotic weld cells", pain: "Tip wear" }
  });
  assert.ok(article.title.includes("Robotic weld cell maintenance"));
  assert.ok(article.body.includes("## Frequently asked questions"));
  assert.ok(article.body.includes("Schedule a plant walk"));
  assert.equal(article.seoData.faqs.length, 5);
  const report = validateSeoDraft({
    title: article.title,
    body: article.body,
    seoData: article.seoData,
    settings: { approvedCta: "Schedule a plant walk", minimumWords: 700, minimumFaqs: 5 }
  });
  assert.equal(report.passed, true);
});

test("autoPatchDraft automatically resolves missing rules, CTA, FAQs, and word count", () => {
  const shortDraft = {
    title: "Centrifugal pump maintenance",
    body: "Short paragraph without headings or FAQs.",
    seoData: { metaDescription: "Too short", faqs: [], schema: [] },
    settings: { approvedCta: "Book a technical review", minimumWords: 700, minimumFaqs: 5 }
  };
  const patched = autoPatchDraft(shortDraft);
  assert.equal(patched.report.passed, true);
  assert.ok(patched.body.includes("Book a technical review"));
  assert.ok(patched.body.includes("## Frequently asked questions"));
  assert.ok(patched.seoData.faqs.length >= 5);
  assert.ok(patched.seoData.metaDescription.length >= 100 && patched.seoData.metaDescription.length <= 160);
});

test("Google Gemini client handles chat completion and offline fallback gracefully", async () => {
  const mockFetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: "Gemini: Recommended topics for Precision Machining include CNC vs EDM." }] } }
        ]
      })
    };
  };

  const client = createGeminiClient({
    apiKey: "mock-gemini-key-for-unit-testing",
    fetchImpl: mockFetch
  });

  const reply = await client.chat({ prompt: "Suggest topic ideas" });
  assert.ok(reply.includes("CNC vs EDM"));

  // Test fallback response generator
  const fallback = generateContextualIndustrialResponse("Suggest topics", { vertical: "Aerospace & Defense" });
  assert.ok(fallback.includes("Industrial Topic Strategy"));
  assert.ok(fallback.includes("Aerospace & Defense"));

  const schemaFallback = generateContextualIndustrialResponse("Generate FAQ schema", { vertical: "Robotics" });
  assert.ok(schemaFallback.includes("TechArticle") || schemaFallback.includes("schema.org"));
});
