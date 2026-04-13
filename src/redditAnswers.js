import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CookieJar } from "./cookieJar.js";
import { renderRichtextDocument } from "./rtjson.js";

const REDDIT_WEB_ORIGIN = "https://www.reddit.com";
const ANSWERS_ORIGIN = "https://answers.reddit.com";
const DEFAULT_BOOTSTRAP_URL = `${REDDIT_WEB_ORIGIN}/answers`;
const FALLBACK_BOOTSTRAP_URL = `${REDDIT_WEB_ORIGIN}/r/popular/`;
const USER_AGENT =
  process.env.REDDIT_ANSWERS_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const DEFAULT_SUPPORTED_FEATURES = [
  "ra:block_quote",
  "ra:inline_quote",
  "ra:source",
  "ra:carousel",
  "ra:videocard",
  "ra:imagecard",
  "ra:product",
  "ra:retailers",
  "ra:retailer",
  "ra:grid",
  "ra:subreddit",
  "ra:reasoning",
  "ra:thinking_step",
  "ra:subreddit_source_bar",
  "ra:post_sources",
  "ra:post_source",
  "ra:subreddit_sources",
  "ra:subreddit_source",
  "ra:serp_unit",
  "ra:post",
  "ra:subreddit",
];

function getCacheRoot() {
  if (process.env.REDDIT_ANSWERS_SESSION_PATH) {
    return path.dirname(process.env.REDDIT_ANSWERS_SESSION_PATH);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "reddit-answers-mcp");
  }

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "reddit-answers-mcp");
  }

  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "reddit-answers-mcp");
}

function getDefaultSessionPath() {
  return process.env.REDDIT_ANSWERS_SESSION_PATH ?? path.join(getCacheRoot(), "session.json");
}

function getSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractPageTitle(html) {
  return html.match(/<title>(.*?)<\/title>/i)?.[1]?.trim() ?? "";
}

function isChallengePage(html) {
  return /name="js_challenge"\s+value="1"/i.test(html) && /name="solution"/i.test(html);
}

function parseChallenge(html, requestUrl) {
  const token = html.match(/name="token"\s+value="([^"]+)"/i)?.[1];
  const formAction = html.match(/<form[^>]*action="([^"]+)"/i)?.[1];
  const seed = html.match(/await\s*\(\s*async\s+([a-zA-Z_$][\w$]*)\s*=>\s*\1\s*\+\s*\1\s*\)\s*\(\s*"([^"]+)"\s*\)/)?.[2];

  if (!token || !formAction || !seed) {
    return null;
  }

  const originalUrl = new URL(requestUrl);
  const solvedUrl = new URL(formAction, requestUrl);

  for (const [key, value] of originalUrl.searchParams) {
    if (!solvedUrl.searchParams.has(key)) {
      solvedUrl.searchParams.set(key, value);
    }
  }

  solvedUrl.searchParams.set("solution", `${seed}${seed}`);
  solvedUrl.searchParams.set("js_challenge", "1");
  solvedUrl.searchParams.set("token", token);

  return {
    seed,
    token,
    solvedUrl: solvedUrl.toString(),
  };
}

function decodeJwtPayload(token) {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }

  try {
    const payload = segments[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(segments[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function pointerSegments(pointer) {
  if (!pointer) {
    return [];
  }

  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function ensureParent(root, segments) {
  let target = root;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const nextIsArray = nextSegment === "-" || /^\d+$/.test(nextSegment);

    if (Array.isArray(target)) {
      const numericIndex = Number.parseInt(segment, 10);
      if (target[numericIndex] === undefined) {
        target[numericIndex] = nextIsArray ? [] : {};
      }
      target = target[numericIndex];
      continue;
    }

    if (target[segment] === undefined) {
      target[segment] = nextIsArray ? [] : {};
    }
    target = target[segment];
  }

  return target;
}

function removeAtPointer(root, pointer) {
  const segments = pointerSegments(pointer);
  if (!segments.length) {
    const removed = structuredClone(root);
    return { root: undefined, value: removed };
  }

  const parent = ensureParent(root, segments);
  const key = segments.at(-1);

  if (Array.isArray(parent)) {
    const index = Number.parseInt(key, 10);
    const [value] = parent.splice(index, 1);
    return { root, value };
  }

  const value = parent[key];
  delete parent[key];
  return { root, value };
}

function assignAtPointer(root, pointer, value, operation) {
  const segments = pointerSegments(pointer);

  if (!segments.length) {
    return structuredClone(value);
  }

  const parent = ensureParent(root, segments);
  const key = segments.at(-1);

  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(structuredClone(value));
      return root;
    }

    const index = Number.parseInt(key, 10);
    if (operation === "add") {
      parent.splice(index, 0, structuredClone(value));
    } else {
      parent[index] = structuredClone(value);
    }
    return root;
  }

  parent[key] = structuredClone(value);
  return root;
}

function applyPatchOperations(baseState, operations) {
  let state = structuredClone(baseState);

  for (const operation of operations) {
    if (!operation || typeof operation !== "object") {
      continue;
    }

    switch (operation.op) {
      case "add":
      case "replace":
        state = assignAtPointer(state, operation.path ?? "", operation.value, operation.op);
        break;
      case "move": {
        const removed = removeAtPointer(state, operation.from ?? "");
        state = removed.root;
        state = assignAtPointer(state, operation.path ?? "", removed.value, "add");
        break;
      }
      case "remove": {
        const removed = removeAtPointer(state, operation.path ?? "");
        state = removed.root;
        break;
      }
      default:
        break;
    }
  }

  return state;
}

function parseSseEventBlock(block) {
  const event = {
    id: null,
    event: "message",
    data: "",
  };
  const dataLines = [];

  for (const line of block.split("\n")) {
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).replace(/^ /, "");

    if (key === "data") {
      dataLines.push(rawValue);
    } else if (key === "id") {
      event.id = rawValue;
    } else if (key === "event") {
      event.event = rawValue || "message";
    }
  }

  event.data = dataLines.join("\n");
  return event;
}

function parseSse(text) {
  return text
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseSseEventBlock);
}

function collectEventCounts(events) {
  const counts = {};
  for (const event of events) {
    counts[event.event] = (counts[event.event] ?? 0) + 1;
  }
  return counts;
}

function extractThingIds(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object") {
        return item.ID ?? item.id ?? null;
      }

      return null;
    })
    .filter(Boolean);
}

function extractFollowUps(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object") {
        return item.query ?? null;
      }

      return null;
    })
    .filter(Boolean);
}

function formatTokenExpiry(expiresAt) {
  return expiresAt ? new Date(expiresAt).toISOString() : null;
}

function defaultHeadersForHtml(userAgent) {
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": userAgent,
  };
}

function headersForJson(userAgent, { origin, referer } = {}) {
  const headers = {
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "user-agent": userAgent,
  };

  if (origin) {
    headers.origin = origin;
  }

  if (referer) {
    headers.referer = referer;
  }

  return headers;
}

function headersForAnswers(userAgent, bearerToken) {
  return {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "authorization": `Bearer ${bearerToken}`,
    "content-type": "application/json",
    "origin": REDDIT_WEB_ORIGIN,
    "referer": `${REDDIT_WEB_ORIGIN}/`,
    "user-agent": userAgent,
    "x-reddit-app-name": "web3x",
  };
}

export class RedditAnswersClient {
  constructor({
    fetchImpl = fetch,
    now = () => Date.now(),
    sessionPath = getDefaultSessionPath(),
    userAgent = USER_AGENT,
    bootstrapUrls = [
      process.env.REDDIT_ANSWERS_BOOTSTRAP_URL,
      DEFAULT_BOOTSTRAP_URL,
      FALLBACK_BOOTSTRAP_URL,
    ].filter(Boolean),
  } = {}) {
    this._fetch = fetchImpl;
    this._now = now;
    this._sessionPath = sessionPath;
    this._userAgent = userAgent;
    this._bootstrapUrls = [...new Set(bootstrapUrls)];
    this._cookieJar = new CookieJar([], { now });
    this._token = null;
    this._tokenExpiresAt = null;
    this._loaded = false;
    this._refreshPromise = null;
    this._refreshPromiseForce = false;
  }

  async _loadSession() {
    if (this._loaded) {
      return;
    }

    this._loaded = true;

    try {
      const raw = await fs.readFile(this._sessionPath, "utf8");
      const data = JSON.parse(raw);
      this._cookieJar = CookieJar.fromJSON(data.cookies, { now: this._now });
      this._token = data.token ?? null;
      this._tokenExpiresAt = data.tokenExpiresAt ?? null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async _saveSession() {
    await fs.mkdir(path.dirname(this._sessionPath), { recursive: true });
    const payload = {
      token: this._token,
      tokenExpiresAt: this._tokenExpiresAt,
      cookies: this._cookieJar.toJSON(),
      userAgent: this._userAgent,
      updatedAt: this._now(),
    };
    const temporaryPath = `${this._sessionPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this._sessionPath);
  }

  async _fetchWithCookies(url, init = {}) {
    const headers = new Headers(init.headers ?? {});
    const cookieHeader = this._cookieJar.getCookieHeader(url);

    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
    }

    const response = await this._fetch(url, {
      ...init,
      headers,
    });

    this._cookieJar.setCookies(getSetCookieHeaders(response), url);
    return response;
  }

  _hasFreshToken() {
    return Boolean(this._token && this._tokenExpiresAt && this._tokenExpiresAt - this._now() > 60_000);
  }

  _invalidateAccessToken() {
    this._token = null;
    this._tokenExpiresAt = null;
  }

  async _deriveTokenFromCookie() {
    const token = this._cookieJar.getCookieValue("token_v2", REDDIT_WEB_ORIGIN);
    if (!token) {
      return false;
    }

    const payload = decodeJwtPayload(token);
    if (!payload?.exp) {
      return false;
    }

    this._token = token;
    this._tokenExpiresAt = Math.floor(payload.exp * 1000);
    await this._saveSession();
    return true;
  }

  async _mintTokenFromCookies() {
    const csrfToken = this._cookieJar.getCookieValue("csrf_token", REDDIT_WEB_ORIGIN);
    if (!csrfToken) {
      return false;
    }

    const response = await this._fetchWithCookies(`${REDDIT_WEB_ORIGIN}/svc/shreddit/token`, {
      method: "POST",
      headers: headersForJson(this._userAgent, {
        origin: REDDIT_WEB_ORIGIN,
        referer: `${REDDIT_WEB_ORIGIN}/`,
      }),
      body: JSON.stringify({ csrf_token: csrfToken }),
    });

    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    if (!payload?.token || !payload?.expires) {
      return false;
    }

    this._token = payload.token;
    this._tokenExpiresAt = payload.expires;
    await this._saveSession();
    return true;
  }

  async _fetchVerifiedPage(url) {
    let currentUrl = url;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this._fetchWithCookies(currentUrl, {
        headers: defaultHeadersForHtml(this._userAgent),
      });
      const html = await response.text();

      if (!isChallengePage(html)) {
        return { html, finalUrl: currentUrl, title: extractPageTitle(html) };
      }

      const challenge = parseChallenge(html, currentUrl);
      if (!challenge) {
        throw new Error(`Reddit challenge page could not be parsed for ${currentUrl}`);
      }

      currentUrl = challenge.solvedUrl;
    }

    throw new Error(`Reddit challenge did not resolve after multiple attempts for ${url}`);
  }

  async _bootstrapSession() {
    for (const bootstrapUrl of this._bootstrapUrls) {
      await this._fetchVerifiedPage(bootstrapUrl);

      if (await this._mintTokenFromCookies()) {
        return bootstrapUrl;
      }

      if (await this._deriveTokenFromCookie()) {
        return bootstrapUrl;
      }
    }

    throw new Error("Unable to bootstrap a Reddit Answers session with any configured URL.");
  }

  async _refreshSession(forceRefresh) {
    if (!forceRefresh && this._hasFreshToken()) {
      return;
    }

    if (forceRefresh) {
      this._invalidateAccessToken();

      if (await this._mintTokenFromCookies()) {
        return;
      }

      await this._bootstrapSession();
      return;
    }

    if (await this._mintTokenFromCookies()) {
      return;
    }

    if (await this._deriveTokenFromCookie()) {
      return;
    }

    await this._bootstrapSession();
  }

  async ensureSession({ forceRefresh = false } = {}) {
    await this._loadSession();

    if (!forceRefresh && this._hasFreshToken()) {
      return this.getStatus();
    }

    if (this._refreshPromise) {
      if (forceRefresh && !this._refreshPromiseForce) {
        await this._refreshPromise;
        return this.ensureSession({ forceRefresh: true });
      }

      await this._refreshPromise;
      return this.getStatus();
    }

    this._refreshPromiseForce = forceRefresh;
    this._refreshPromise = this._refreshSession(forceRefresh).finally(() => {
      this._refreshPromise = null;
      this._refreshPromiseForce = false;
    });

    await this._refreshPromise;
    return this.getStatus();
  }

  async getStatus() {
    await this._loadSession();

    const tokenExpiresInSeconds =
      this._tokenExpiresAt && this._tokenExpiresAt > this._now()
        ? Math.floor((this._tokenExpiresAt - this._now()) / 1000)
        : null;

    return {
      ready: this._hasFreshToken(),
      hasCachedToken: Boolean(this._token),
      tokenExpiresAt: formatTokenExpiry(this._tokenExpiresAt),
      tokenExpiresInSeconds,
      cookieNames: this._cookieJar.listCookieNames(),
      sessionPath: this._sessionPath,
      bootstrapUrls: this._bootstrapUrls,
      userAgent: this._userAgent,
    };
  }

  _buildAnswerRequest(answerId, query) {
    return {
      format: "RTJSON",
      query,
      source: "ANSWERS",
      correlationId: `${answerId}__${new Date(this._now()).toISOString()}`,
      supportedFeatures: DEFAULT_SUPPORTED_FEATURES,
    };
  }

  async _callAnswersEndpoint(answerId, query) {
    const response = await this._fetch(`${ANSWERS_ORIGIN}/v1/answers/${answerId}`, {
      method: "POST",
      headers: headersForAnswers(this._userAgent, this._token),
      body: JSON.stringify(this._buildAnswerRequest(answerId, query)),
    });

    return response;
  }

  async _runAnswerRequest(answerId, query, { includeReasoning = false } = {}) {
    await this.ensureSession();

    let response = await this._callAnswersEndpoint(answerId, query);

    if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => {});
      await this.ensureSession({ forceRefresh: true });
      response = await this._callAnswersEndpoint(answerId, query);
    }

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Reddit Answers request failed with ${response.status}: ${responseText.slice(0, 500)}`);
    }

    const events = parseSse(responseText);
    const counts = collectEventCounts(events);
    let state = {
      comments: [],
      followUps: [],
      posts: [],
      subreddits: [],
      richtext: { document: [] },
    };
    let quota = null;
    let success = false;

    for (const event of events) {
      if (event.event === "userQuota" && event.data) {
        quota = JSON.parse(event.data);
        continue;
      }

      if (event.event === "patch" && event.data) {
        const operations = JSON.parse(event.data);
        state = applyPatchOperations(state, operations);
        continue;
      }

      if (event.event === "success") {
        success = true;
      }
    }

    const answerText = renderRichtextDocument(state.richtext?.document ?? [], { includeReasoning });

    return {
      answerId,
      query,
      answerText,
      followUps: extractFollowUps(state.followUps),
      sourcePostIds: extractThingIds(state.posts),
      sourceCommentIds: extractThingIds(state.comments),
      sourceSubredditIds: extractThingIds(state.subreddits),
      quotaRemaining: quota?.queriesRemaining ?? null,
      quotaResetSeconds: quota?.timeUntilResetSeconds ?? null,
      patchEventCount: counts.patch ?? 0,
      totalEventCount: events.length,
      success,
      contentType: "text/event-stream",
    };
  }

  async search(query, options = {}) {
    const answerId = crypto.randomUUID();
    return this._runAnswerRequest(answerId, query, options);
  }

  async followUp(answerId, query, options = {}) {
    return this._runAnswerRequest(answerId, query, options);
  }
}

export function formatAnswerResult(result) {
  const lines = [
    `Answer ID: ${result.answerId}`,
    `Query: ${result.query}`,
    "",
    result.answerText || "(No answer text rendered.)",
  ];

  if (result.followUps.length) {
    lines.push("", "Suggested follow-ups:");
    for (const followUp of result.followUps) {
      lines.push(`- ${followUp}`);
    }
  }

  if (result.sourceSubredditIds.length || result.sourcePostIds.length || result.sourceCommentIds.length) {
    lines.push("", "Source IDs:");

    if (result.sourceSubredditIds.length) {
      lines.push(`Subreddits: ${result.sourceSubredditIds.join(", ")}`);
    }

    if (result.sourcePostIds.length) {
      lines.push(`Posts: ${result.sourcePostIds.join(", ")}`);
    }

    if (result.sourceCommentIds.length) {
      lines.push(`Comments: ${result.sourceCommentIds.join(", ")}`);
    }
  }

  return lines.join("\n");
}

export function formatSessionStatus(status) {
  const lines = [
    `Ready: ${status.ready ? "yes" : "no"}`,
    `Has cached token: ${status.hasCachedToken ? "yes" : "no"}`,
    `Token expires at: ${status.tokenExpiresAt ?? "n/a"}`,
    `Token expires in: ${status.tokenExpiresInSeconds ?? "n/a"} seconds`,
    `Session path: ${status.sessionPath}`,
    `Bootstrap URLs: ${status.bootstrapUrls.join(", ")}`,
    `Cookies: ${status.cookieNames.join(", ") || "(none)"}`,
  ];

  return lines.join("\n");
}

export const _internals = {
  parseChallenge,
  isChallengePage,
  parseSse,
  applyPatchOperations,
  decodeJwtPayload,
};
