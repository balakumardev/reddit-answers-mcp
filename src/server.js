#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

import { RedditAnswersClient, formatAnswerResult, formatSessionStatus } from "./redditAnswers.js";

const answerOutputSchema = {
  answerId: z.string().uuid(),
  query: z.string(),
  answerText: z.string(),
  followUps: z.array(z.string()),
  sourcePostIds: z.array(z.string()),
  sourceCommentIds: z.array(z.string()),
  sourceSubredditIds: z.array(z.string()),
  quotaRemaining: z.number().int().nullable(),
  quotaResetSeconds: z.number().int().nullable(),
  patchEventCount: z.number().int().nonnegative(),
  totalEventCount: z.number().int().nonnegative(),
  success: z.boolean(),
  contentType: z.string(),
};

const statusOutputSchema = {
  ready: z.boolean(),
  hasCachedToken: z.boolean(),
  tokenExpiresAt: z.string().nullable(),
  tokenExpiresInSeconds: z.number().int().nullable(),
  cookieNames: z.array(z.string()),
  sessionPath: z.string(),
  bootstrapUrls: z.array(z.string()),
  userAgent: z.string(),
};

const client = new RedditAnswersClient();
const server = new McpServer({
  name: "reddit-answers",
  version: "1.0.0",
});

server.registerTool(
  "reddit_answers_search",
  {
    description: "Ask Reddit Answers a brand-new question using a fully browserless bootstrap flow and return the final answer plus follow-up suggestions.",
    inputSchema: {
      query: z.string().min(1).describe("The question to ask Reddit Answers."),
      includeReasoning: z.boolean().optional().describe("Whether to include Reddit's visible reasoning/thinking blocks in the rendered answer text."),
    },
    outputSchema: answerOutputSchema,
  },
  async ({ query, includeReasoning = false }) => {
    const result = await client.search(query, { includeReasoning });
    return {
      content: [{ type: "text", text: formatAnswerResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "reddit_answers_follow_up",
  {
    description: "Ask a follow-up question in an existing Reddit Answers conversation by reusing a prior answer ID.",
    inputSchema: {
      answerId: z.string().uuid().describe("The answer ID returned by reddit_answers_search or a previous follow-up."),
      query: z.string().min(1).describe("The follow-up question to ask."),
      includeReasoning: z.boolean().optional().describe("Whether to include Reddit's visible reasoning/thinking blocks in the rendered answer text."),
    },
    outputSchema: answerOutputSchema,
  },
  async ({ answerId, query, includeReasoning = false }) => {
    const result = await client.followUp(answerId, query, { includeReasoning });
    return {
      content: [{ type: "text", text: formatAnswerResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "reddit_answers_session_status",
  {
    description: "Inspect the current cached Reddit Answers browserless session, token expiry, cookie names, and bootstrap URLs.",
    outputSchema: statusOutputSchema,
  },
  async () => {
    const status = await client.getStatus();
    return {
      content: [{ type: "text", text: formatSessionStatus(status) }],
      structuredContent: status,
    };
  },
);

server.registerTool(
  "reddit_answers_refresh_session",
  {
    description: "Force-refresh the browserless Reddit Answers session and bearer token by replaying Reddit's current JS challenge flow over plain HTTP.",
    outputSchema: statusOutputSchema,
  },
  async () => {
    const status = await client.ensureSession({ forceRefresh: true });
    return {
      content: [{ type: "text", text: formatSessionStatus(status) }],
      structuredContent: status,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("reddit-answers MCP server running on stdio");
}

main().catch((error) => {
  console.error("reddit-answers MCP server failed:", error);
  process.exit(1);
});
