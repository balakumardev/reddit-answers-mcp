import test from "node:test";
import assert from "node:assert/strict";

import { RedditAnswersClient, _internals } from "../src/redditAnswers.js";

test("parseChallenge extracts Reddit's current doubling challenge", () => {
  const html = `
    <title>Reddit - Please wait for verification</title>
    <script>
      document.addEventListener("DOMContentLoaded", async function() {
        var e = document.forms[0], n = (await (async e=>e+e)("4c1b5df74d1d92cf"));
        e.elements.namedItem("solution").value = n;
      });
    </script>
    <form hidden method="GET" action="/answers">
      <input type="hidden" name="solution" />
      <input type="hidden" name="js_challenge" value="1" />
      <input type="hidden" name="token" value="abc123" />
    </form>
  `;

  const parsed = _internals.parseChallenge(html, "https://www.reddit.com/answers?q=hello");
  assert.ok(parsed);
  assert.equal(parsed.seed, "4c1b5df74d1d92cf");
  assert.equal(
    parsed.solvedUrl,
    "https://www.reddit.com/answers?q=hello&solution=4c1b5df74d1d92cf4c1b5df74d1d92cf&js_challenge=1&token=abc123",
  );
});

test("parseSse and applyPatchOperations reconstruct a simple answer state", () => {
  const sse = `id: 1
event: userQuota
data: {"queriesRemaining":29,"timeUntilResetSeconds":123}

id: 2
event: patch
data: [{"op":"replace","path":"","value":{"comments":[],"followUps":[],"posts":[],"subreddits":[],"richtext":{"document":[{"e":"par","c":[{"e":"text","t":"Hello"}]}]}}}]

id: 3
event: patch
data: [{"op":"replace","path":"/followUps","value":[{"query":"What next?"}]}]

id: 4
event: success
data: {}
`;

  const events = _internals.parseSse(sse);
  const patchPayloads = events
    .filter((event) => event.event === "patch")
    .map((event) => JSON.parse(event.data));

  let state = {};
  for (const operations of patchPayloads) {
    state = _internals.applyPatchOperations(state, operations);
  }

  assert.equal(events.length, 4);
  assert.equal(state.richtext.document[0].c[0].t, "Hello");
  assert.equal(state.followUps[0].query, "What next?");
});

test("runAnswerRequest retries once with forced refresh after a 401 even when token looked fresh", async () => {
  const client = new RedditAnswersClient({
    fetchImpl: async () => {
      throw new Error("fetch should not be used in this test");
    },
  });

  client._loaded = true;
  client._token = "cached-token";
  client._tokenExpiresAt = Date.now() + 10 * 60_000;

  const ensureCalls = [];
  client.ensureSession = async ({ forceRefresh = false } = {}) => {
    ensureCalls.push(forceRefresh);
  };

  let callCount = 0;
  client._callAnswersEndpoint = async () => {
    callCount += 1;

    if (callCount === 1) {
      return new Response("unauthorized", { status: 401 });
    }

    return new Response(
      `id: 1
event: patch
data: [{"op":"replace","path":"","value":{"comments":[],"followUps":[],"posts":[],"subreddits":[],"richtext":{"document":[{"e":"par","c":[{"e":"text","t":"Retried"}]}]}}}]

id: 2
event: success
data: {}
`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  };

  const result = await client._runAnswerRequest("11111111-1111-4111-8111-111111111111", "hello");

  assert.deepEqual(ensureCalls, [false, true]);
  assert.equal(callCount, 2);
  assert.equal(result.success, true);
  assert.equal(result.answerText, "Retried");
});

test("ensureSession serializes concurrent refreshes", async () => {
  const client = new RedditAnswersClient({
    fetchImpl: async () => {
      throw new Error("fetch should not be used in this test");
    },
  });

  client._loaded = true;

  let mintCalls = 0;
  client._mintTokenFromCookies = async () => {
    mintCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    client._token = "fresh-token";
    client._tokenExpiresAt = Date.now() + 10 * 60_000;
    return true;
  };
  client._deriveTokenFromCookie = async () => false;
  client._bootstrapSession = async () => {
    throw new Error("bootstrap should not be needed");
  };

  const [first, second] = await Promise.all([client.ensureSession(), client.ensureSession()]);

  assert.equal(mintCalls, 1);
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
});
