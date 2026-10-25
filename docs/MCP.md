# The review desk as an MCP server

An AI assistant that speaks the Model Context Protocol can read the review desk and ask it for a recommendation. It cannot decide anything: the server has no tool that approves, overrides, reopens a close, blocks, changes policy or touches autonomy. A person decides.

## Run it

```bash
DESK_API_URL=http://localhost:8000 DESK_TOKEN=<your token> npm run mcp          # a deployment with sign-in on
DESK_API_URL=http://localhost:8000 DESK_DEMO_USER=analyst_demo npm run mcp      # sample mode
```

It speaks JSON-RPC 2.0 over stdio (one message per line). Add it to an assistant's configuration as a command, for example:

```json
{
  "mcpServers": {
    "sanctions-desk": {
      "command": "npm",
      "args": ["run", "-s", "mcp"],
      "cwd": "/path/to/sanctions-desk",
      "env": { "DESK_API_URL": "http://localhost:8000", "DESK_DEMO_USER": "analyst_demo" }
    }
  }
}
```

Every call goes through the desk's own API with the credentials you give it, so sign-in, roles and the audit log apply exactly as for a person.

## Tools

| Tool             | What it does                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_alerts`    | The queue, with the latest recommendation and where people have taken it. Filters: `alert_type`, `reviewed`.                                   |
| `review_alert`   | Runs the desk's review of one alert and returns the **recommendation** with the evidence that decided it. Nothing is decided, blocked or sent. |
| `get_case`       | Where a case stands: the recommendation, what people did, the records prepared after their decision.                                           |
| `get_case_file`  | The case file as Markdown.                                                                                                                     |
| `verify_receipt` | Checks a stored signed receipt: signature, pinned key, and which Nemotron model served the call under which app and mode.                      |
| `explain_policy` | The active policy in brief: version, autonomy level, thresholds, and what is locked.                                                           |

`apps/api/test/mcp-api.test.ts` runs the server against the real API with sign-in on: no token is refused, a viewer can read the queue but not start a review, an analyst gets a recommendation, and the tool list is exactly the six above, so no decision (and no four-eyes step) can be made through it. The unit tests (`packages/shared/test/mcp.test.ts`) check that no tool name or schema can approve, decide, override or change policy, that ids are encoded before they reach a path, and that a failed call comes back as a tool error in the desk's own words.
