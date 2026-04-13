import test from "node:test";
import assert from "node:assert/strict";

import { _internals } from "../src/redditAnswers.js";

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
