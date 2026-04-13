import test from "node:test";
import assert from "node:assert/strict";

import { CookieJar } from "../src/cookieJar.js";

test("CookieJar stores and sends host and domain cookies", () => {
  const jar = new CookieJar([], { now: () => 1_000 });
  jar.setCookie("edgebucket=abc; Path=/; Secure", "https://www.reddit.com/answers");
  jar.setCookie("csrf_token=xyz; Domain=.reddit.com; Path=/; Secure", "https://www.reddit.com/answers");

  assert.equal(jar.getCookieValue("edgebucket", "https://www.reddit.com/answers"), "abc");
  assert.equal(jar.getCookieValue("csrf_token", "https://answers.reddit.com/v1/answers/demo"), "xyz");
  assert.match(jar.getCookieHeader("https://www.reddit.com/answers"), /edgebucket=abc/);
  assert.match(jar.getCookieHeader("https://www.reddit.com/answers"), /csrf_token=xyz/);
});

test("CookieJar honors expiry", () => {
  let now = 1_000;
  const jar = new CookieJar([], { now: () => now });
  jar.setCookie("temp=value; Max-Age=1; Path=/", "https://www.reddit.com/");

  assert.equal(jar.getCookieValue("temp", "https://www.reddit.com/"), "value");
  now = 2_500;
  assert.equal(jar.getCookieValue("temp", "https://www.reddit.com/"), null);
});
