import { URL } from "node:url";

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith("/")) {
    return "/";
  }

  if (pathname === "/") {
    return "/";
  }

  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function normalizeDomain(domain) {
  return domain.replace(/^\./, "").toLowerCase();
}

function domainMatches(hostname, cookie) {
  if (cookie.hostOnly) {
    return hostname === cookie.domain;
  }

  return hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath, cookiePath) {
  return requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`) || requestPath.startsWith(cookiePath);
}

function parseSetCookie(setCookie, requestUrl, now) {
  const url = new URL(requestUrl);
  const parts = setCookie.split(";");
  const [nameValue, ...attributeParts] = parts;
  const equalsIndex = nameValue.indexOf("=");

  if (equalsIndex === -1) {
    return null;
  }

  const name = nameValue.slice(0, equalsIndex).trim();
  const value = nameValue.slice(equalsIndex + 1).trim();

  if (!name) {
    return null;
  }

  const cookie = {
    name,
    value,
    domain: url.hostname.toLowerCase(),
    hostOnly: true,
    path: defaultPath(url.pathname),
    secure: false,
    httpOnly: false,
    sameSite: null,
    expiresAt: null,
  };

  for (const rawAttribute of attributeParts) {
    const attribute = rawAttribute.trim();
    if (!attribute) {
      continue;
    }

    const attributeIndex = attribute.indexOf("=");
    const key = (attributeIndex === -1 ? attribute : attribute.slice(0, attributeIndex)).trim().toLowerCase();
    const rawValue = attributeIndex === -1 ? "" : attribute.slice(attributeIndex + 1).trim();

    switch (key) {
      case "domain":
        if (rawValue) {
          cookie.domain = normalizeDomain(rawValue);
          cookie.hostOnly = false;
        }
        break;
      case "path":
        cookie.path = rawValue && rawValue.startsWith("/") ? rawValue : "/";
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "samesite":
        cookie.sameSite = rawValue || null;
        break;
      case "max-age": {
        const seconds = Number.parseInt(rawValue, 10);
        if (Number.isFinite(seconds)) {
          cookie.expiresAt = now + seconds * 1000;
        }
        break;
      }
      case "expires": {
        const expiresAt = Date.parse(rawValue);
        if (!Number.isNaN(expiresAt)) {
          cookie.expiresAt = expiresAt;
        }
        break;
      }
      default:
        break;
    }
  }

  return cookie;
}

export class CookieJar {
  constructor(entries = [], { now = () => Date.now() } = {}) {
    this._now = now;
    this._cookies = [];

    for (const entry of entries) {
      this._cookies.push({ ...entry });
    }
  }

  static fromJSON(value, options) {
    return new CookieJar(Array.isArray(value) ? value : [], options);
  }

  toJSON() {
    return this._cookies.map((cookie) => ({ ...cookie }));
  }

  _removeExpired() {
    const now = this._now();
    this._cookies = this._cookies.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now);
  }

  setCookie(setCookie, requestUrl) {
    const cookie = parseSetCookie(setCookie, requestUrl, this._now());
    if (!cookie) {
      return;
    }

    this._cookies = this._cookies.filter(
      (existing) =>
        !(
          existing.name === cookie.name &&
          existing.domain === cookie.domain &&
          existing.path === cookie.path
        ),
    );

    if (cookie.expiresAt !== null && cookie.expiresAt <= this._now()) {
      return;
    }

    this._cookies.push(cookie);
    this._removeExpired();
  }

  setCookies(setCookies, requestUrl) {
    for (const setCookie of setCookies) {
      this.setCookie(setCookie, requestUrl);
    }
  }

  getCookies(requestUrl) {
    this._removeExpired();

    const url = new URL(requestUrl);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname || "/";
    const isHttps = url.protocol === "https:";

    return this._cookies
      .filter((cookie) => {
        if (cookie.secure && !isHttps) {
          return false;
        }

        if (!domainMatches(hostname, cookie)) {
          return false;
        }

        return pathMatches(pathname, cookie.path);
      })
      .sort((left, right) => right.path.length - left.path.length);
  }

  getCookieHeader(requestUrl) {
    const cookies = this.getCookies(requestUrl);
    if (!cookies.length) {
      return "";
    }

    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  getCookieValue(name, requestUrl) {
    const cookie = this.getCookies(requestUrl).find((entry) => entry.name === name);
    return cookie ? cookie.value : null;
  }

  listCookieNames() {
    this._removeExpired();
    return [...new Set(this._cookies.map((cookie) => cookie.name))].sort();
  }
}
