const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
const net = require("node:net");

function createSecretCipher(encodedKey) {
  const key = Buffer.from(encodedKey || "", "base64");
  if (key.length !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");

  return {
    encrypt(value) {
      if (typeof value !== "string" || !value) throw new Error("A non-empty integration secret is required.");
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
    },
    decrypt(value) {
      const [version, ivText, tagText, ciphertextText] = String(value || "").split(":");
      if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
        throw new Error("Stored integration secret has an invalid format.");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextText, "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

function normalizeWordPressSiteUrl(value) {
  if (typeof value !== "string" || value.length > 255) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.port && url.port !== "443" || net.isIP(url.hostname)) return null;
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function isPublicIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

async function safeHttpsJsonRequest(urlValue, { method = "GET", headers = {}, body, maxResponseBytes = 1_000_000 } = {}) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.port && url.port !== "443" || net.isIP(url.hostname)) {
    throw new Error("WordPress publishing requires a public HTTPS hostname on port 443.");
  }
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  const address = records.find((record) => isPublicIpv4(record.address));
  if (!address) throw new Error("WordPress host must resolve to a public IPv4 address.");

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, 4)
    }, (response) => {
      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          request.destroy(new Error("WordPress response exceeded the allowed size."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const statusCode = response.statusCode || 500;
        if (statusCode >= 300 && statusCode < 400) {
          reject(new Error("WordPress redirected the request. Verify the configured site URL."));
          return;
        }
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reject(new Error(`WordPress returned an invalid response (${statusCode}).`));
          return;
        }
        resolve({ statusCode, data });
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error("WordPress request timed out.")));
    request.on("error", (error) => reject(error));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function wordpressAuthHeader(username, appPassword) {
  return `Basic ${Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64")}`;
}

function markdownToSafeHtml(markdown) {
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
  const blocks = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(escapeHtml).join(" ")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      blocks.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
    } else if (item) {
      flushParagraph();
      list.push(item[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks.join("\n");
}

async function wordpressRequest(siteUrl, username, appPassword, path, options = {}) {
  const site = new URL(siteUrl);
  const url = new URL(path, site);
  const response = await safeHttpsJsonRequest(url.toString(), {
    method: options.method || "GET",
    headers: {
      Authorization: wordpressAuthHeader(username, appPassword),
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if ([401, 403].includes(response.statusCode)) {
      throw new Error("WordPress rejected the application password or publishing permissions.");
    }
    throw new Error(`WordPress request failed (${response.statusCode}).`);
  }
  return response.data;
}

async function testWordPressConnection(siteUrl, username, appPassword) {
  return wordpressRequest(siteUrl, username, appPassword, "wp-json/wp/v2/users/me?context=edit");
}

async function publishWordPressDraft({ siteUrl, username, appPassword, draft }) {
  const slug = `rankforge-${draft.id}-${draft.version}`;
  const query = new URLSearchParams({ slug, status: "draft,publish", context: "edit" });
  const existing = await wordpressRequest(siteUrl, username, appPassword, `wp-json/wp/v2/posts?${query}`);
  if (Array.isArray(existing) && existing[0] && existing[0].id && existing[0].link) {
    return { postId: existing[0].id, url: existing[0].link };
  }
  const schema = draft.seoData && Array.isArray(draft.seoData.schema) ? draft.seoData.schema : [];
  const jsonLd = schema.length
    ? `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`
    : "";
  const content = `${markdownToSafeHtml(draft.body)}${jsonLd}`;
  const result = await wordpressRequest(siteUrl, username, appPassword, "wp-json/wp/v2/posts", {
    method: "POST",
    body: {
      title: draft.title,
      slug,
      content,
      excerpt: draft.seoData && draft.seoData.metaDescription || "",
      status: "publish"
    }
  });
  if (!result || !result.id || typeof result.link !== "string") {
    throw new Error("WordPress did not confirm the published page.");
  }
  return { postId: result.id, url: result.link };
}

module.exports = {
  createSecretCipher,
  markdownToSafeHtml,
  normalizeWordPressSiteUrl,
  publishWordPressDraft,
  testWordPressConnection
};
