#!/usr/bin/env node

import { RedditAnswersClient } from "../src/redditAnswers.js";

const query = process.argv.slice(2).join(" ") || "best carry-on backpack for business travel";
const client = new RedditAnswersClient();

try {
  const status = await client.ensureSession();
  const result = await client.search(query);

  console.log(
    JSON.stringify(
      {
        session: status,
        result,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exit(1);
}
