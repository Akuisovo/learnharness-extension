/**
 * Optional helper: read RevisionHub / Clerk cookies from the local Search.app
 * (WebKit / WKWebView) cookie store, and mint a fresh short-lived Clerk session
 * token from the longer-lived `__client` cookie.
 *
 * RevisionHub's `__session` cookie is persistent (about a year) but the JWT it
 * contains only lasts about a minute. Clerk rotates it constantly in the
 * browser. Reading the on-disk cookie store alone is therefore racy; the plugin
 * asks Clerk's token endpoint for a fresh JWT directly, using the user's own
 * `__client` token. Nothing else is exposed and no cookie value is logged.
 *
 * macOS / Search.app specific, opt-out, and uses only Node built-ins.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STORE_ROOT = path.join(
  os.homedir(),
  "Library",
  "WebKit",
  "com.officecommun.search",
  "WebsiteDataStore"
);
const CLERK_BASE = "https://clerk.revisionhub.study";
const APPLE_EPOCH_SECONDS = 978307200; // 2001-01-01 -> Unix epoch
const TOKEN_SKEW_MS = 15000;

/** Find the most recently written binarycookies file in Search.app's store. */
function findCookieFile() {
  let stores;
  try {
    stores = fs.readdirSync(STORE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -Infinity;
  for (const store of stores) {
    const file = path.join(STORE_ROOT, store.name, "Cookies", "Cookies.binarycookies");
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs > bestMtime) {
        best = file;
        bestMtime = stat.mtimeMs;
      }
    } catch {
      /* keep looking */
    }
  }
  return best;
}

/** Decode a null-terminated Latin-1 string at a byte offset inside a record. */
function readCString(buffer, offset) {
  if (!offset || offset < 0 || offset >= buffer.length) return "";
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return buffer.toString("latin1", offset, end);
}

/**
 * Parse Safari / WKWebView `Cookies.binarycookies` data.
 * Returns plain objects: { domain, name, path, value, expiresAt, createdAt, flags }.
 * Exported so the format can be tested without a real browser store.
 */
function parseBinaryCookies(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.toString("ascii", 0, 4) !== "cook") {
    return [];
  }
  const pageCount = buffer.readUInt32BE(4);
  if (pageCount > 10000) return [];
  const sizes = [];
  let cursor = 8;
  for (let i = 0; i < pageCount; i++) {
    if (cursor + 4 > buffer.length) return [];
    sizes.push(buffer.readUInt32BE(cursor));
    cursor += 4;
  }

  const cookies = [];
  for (const size of sizes) {
    if (size < 8 || cursor + size > buffer.length) break;
    const page = buffer.subarray(cursor, cursor + size);
    cursor += size;
    if (page.toString("hex", 0, 4) !== "00000100") continue;

    const count = page.readUInt32LE(4);
    if (count > 10000 || 8 + count * 4 > page.length) continue;
    for (let i = 0; i < count; i++) {
      const recordOffset = page.readUInt32LE(8 + i * 4);
      if (recordOffset + 56 > page.length) continue;
      const record = page.subarray(recordOffset);
      const recordSize = record.readUInt32LE(0);
      if (recordSize < 56 || recordSize > record.length) continue;

      const flags = record.readUInt32LE(8);
      const domainOffset = record.readUInt32LE(16);
      const nameOffset = record.readUInt32LE(20);
      const pathOffset = record.readUInt32LE(24);
      const valueOffset = record.readUInt32LE(28);
      const expires = record.readDoubleLE(40);
      const created = record.readDoubleLE(48);

      cookies.push({
        domain: readCString(record, domainOffset),
        name: readCString(record, nameOffset),
        path: readCString(record, pathOffset),
        value: readCString(record, valueOffset),
        expiresAt: Number.isFinite(expires) ? (expires + APPLE_EPOCH_SECONDS) * 1000 : 0,
        createdAt: Number.isFinite(created) ? (created + APPLE_EPOCH_SECONDS) * 1000 : 0,
        flags,
      });
    }
  }
  return cookies;
}

/** Read all cookies whose domain is revisionhub.study or one of its subdomains. */
function readRevisionHubCookies(file) {
  const cookieFile = file || findCookieFile();
  if (!cookieFile) return [];
  let buffer;
  try {
    buffer = fs.readFileSync(cookieFile);
  } catch {
    return [];
  }
  return parseBinaryCookies(buffer).filter((c) => {
    const domain = String(c.domain || "").toLowerCase().replace(/^\./, "");
    return domain === "revisionhub.study" || domain.endsWith(".revisionhub.study");
  });
}

/** Decode the payload of a JWT-like string without verifying its signature. */
function decodeJwt(value) {
  try {
    const part = String(value || "").split(".")[1];
    if (!part) return null;
    let base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

/** JWT expiry in milliseconds, or 0 when the value is not a readable JWT. */
function sessionExpiryMs(value) {
  const payload = decodeJwt(value);
  return Number(payload && payload.exp) ? Number(payload.exp) * 1000 : 0;
}

function isSessionCookie(cookie) {
  return cookie.name === "__session" || /^__session_/.test(cookie.name);
}

/**
 * Build a Cookie header for revisionhub.study. All session-flavoured cookies
 * are set to the supplied token so suffixed-cookie installations keep working.
 */
function buildCookieHeader(cookies, sessionValue) {
  const map = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie.domain || "").toLowerCase().replace(/^\./, "");
    if (domain !== "revisionhub.study") continue; // exclude clerk.* and third parties
    if (!cookie.name || !cookie.value) continue;
    map.set(cookie.name, isSessionCookie(cookie) ? sessionValue : cookie.value);
  }
  if (!map.has("__session") && sessionValue) map.set("__session", sessionValue);
  return [...map].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Pick the freshest readable __session JWT from a cookie list. */
function freshestSession(cookies) {
  return cookies
    .filter(isSessionCookie)
    .map((c) => ({ cookie: c, payload: decodeJwt(c.value) }))
    .filter((x) => x.payload && x.payload.sid)
    .sort((a, b) => (Number(b.payload.exp) || 0) - (Number(a.payload.exp) || 0))[0] || null;
}

/** Backwards-compatible helper: current browser Cookie header, or null. */
function readSearchBrowserCookie(file) {
  const cookies = readRevisionHubCookies(file);
  const chosen = freshestSession(cookies);
  if (!chosen) return null;
  const header = buildCookieHeader(cookies, chosen.cookie.value);
  return header || null;
}

/**
 * Mint a fresh Clerk session JWT using the long-lived `__client` cookie.
 * Returns { cookie, expiresAt, sid, method } or null when it cannot be done.
 * Dependencies are injectable for offline tests.
 */
async function mintFreshSessionCookie(options = {}) {
  const {
    cookies = readRevisionHubCookies(),
    fetchImpl = globalThis.fetch,
    now = Date.now(),
  } = options;
  if (!cookies.length || typeof fetchImpl !== "function") return null;

  const client = cookies.find(
    (c) => c.name === "__client" && /clerk\.revisionhub\.study$/i.test(String(c.domain || "").replace(/^\./, ""))
  ) || cookies.find((c) => c.name === "__client");
  if (!client || !client.value) return null;

  let sid = freshestSession(cookies)?.payload?.sid || "";
  const clerkCookies = cookies
    .filter((c) => /clerk\.revisionhub\.study$/i.test(String(c.domain || "").replace(/^\./, "")))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const authHeaders = {
    Authorization: `Bearer ${client.value}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (clerkCookies) authHeaders.Cookie = clerkCookies;

  try {
    // If every stored __session is unreadable, ask Clerk which session is active.
    if (!sid) {
      const infoResponse = await fetchImpl(`${CLERK_BASE}/v1/client`, {
        method: "GET",
        headers: authHeaders,
      });
      if (!infoResponse || !infoResponse.ok) return null;
      const info = await infoResponse.json();
      const clientInfo = (info && info.response) || info || {};
      sid = clientInfo.last_active_session_id || (clientInfo.sessions || [])[0]?.id || "";
      if (!sid) return null;
    }

    const response = await fetchImpl(`${CLERK_BASE}/v1/client/sessions/${encodeURIComponent(sid)}/tokens`, {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    if (!response || !response.ok) return null;
    const payload = await response.json();
    const jwt = payload && payload.jwt;
    if (!jwt) return null;

    const expiresAt = sessionExpiryMs(jwt) || now + 60000;
    if (expiresAt <= now + TOKEN_SKEW_MS) return null;
    const cookie = buildCookieHeader(cookies, jwt);
    if (!cookie) return null;
    return { cookie, expiresAt, sid, method: "clerk-token" };
  } catch {
    return null;
  }
}

module.exports = {
  findCookieFile,
  parseBinaryCookies,
  readRevisionHubCookies,
  decodeJwt,
  sessionExpiryMs,
  readSearchBrowserCookie,
  mintFreshSessionCookie,
};
