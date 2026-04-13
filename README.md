# reddit-answers-mcp

Browserless MCP server for Reddit Answers by Bala Kumar.

It solves Reddit's current web verification flow over plain HTTP, reuses cached cookies and bearer tokens, and exposes Reddit Answers as local MCP tools you can run over stdio or through `npx`.

## Features

- Browserless Reddit Answers bootstrap over plain HTTP
- Cached `token_v2`, bearer token, and cookies across restarts
- Automatic session refresh before token expiry
- MCP tools for new queries, follow-ups, session status, and forced refresh
- Works as a local stdio MCP server and as an `npx` package

## MCP Tools

- `reddit_answers_search`
- `reddit_answers_follow_up`
- `reddit_answers_session_status`
- `reddit_answers_refresh_session`

## Install

Run directly with `npx`:

```bash
npx reddit-answers-mcp
```

Install locally:

```bash
npm install reddit-answers-mcp
```

## Project MCP Config

Example `.mcp.json` entry:

```json
{
  "mcpServers": {
    "reddit-answers": {
      "command": "npx",
      "args": ["-y", "reddit-answers-mcp"]
    }
  }
}
```

Example `.codex/config.toml` entry:

```toml
[mcp_servers."reddit-answers"]
command = "npx"
args = ["-y", "reddit-answers-mcp"]
```

## Environment

- `REDDIT_ANSWERS_SESSION_PATH`
  Override the session cache file path.
- `REDDIT_ANSWERS_BOOTSTRAP_URL`
  Override the primary Reddit bootstrap URL.
- `REDDIT_ANSWERS_USER_AGENT`
  Override the browser user agent used for Reddit requests.

Default cache location:

- macOS: `~/Library/Caches/reddit-answers-mcp/session.json`
- Linux: `$XDG_CACHE_HOME/reddit-answers-mcp/session.json`
- Windows: `%LOCALAPPDATA%\\reddit-answers-mcp\\session.json`

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run a live smoke test:

```bash
npm run smoke -- "best carry-on backpack for business travel"
```

Run the MCP server locally:

```bash
npm start
```

## Publishing

This repo includes:

- GitHub CI at `.github/workflows/ci.yml`
- npm publish workflow at `.github/workflows/publish.yml`

Publish flow:

1. Add a repository secret named `NPM_TOKEN` with an npm automation token.
2. Bump the package version.
3. Push a tag like `v1.0.1`.
4. GitHub Actions will run tests and publish the package to npm.

Once published, the package will be runnable with:

```bash
npx reddit-answers-mcp
```

## Notes

This project depends on Reddit's current verification and token flow. If Reddit changes the challenge format or adds stronger anti-bot checks, the bootstrap logic may need updates.

## Author

Bala Kumar  
mail@balakumar.dev  
https://balakumar.dev
