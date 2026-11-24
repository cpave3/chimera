# MCP tools

Chimera connects to local MCP servers over stdio and remote servers over MCP
Streamable HTTP. It discovers **tools** when a session starts and exposes them
to the agent as namespaced tools. MCP resources and prompts, legacy SSE, manual
bearer tokens, and OAuth device flow are not supported. Saved MCP configuration
is global only; a launch flag can add servers for one session (see
[Servers for one session](#servers-for-one-session)). There is no project-local
MCP config, in-session hot reload, or TUI `/mcp` screen.

When a server returns `instructions` during initialization, Chimera includes
them in the model's system prompt under that server's configured name. Servers
without instructions add no prompt section. This works independently of mods.

## Add a server

```bash
# Local server: everything after -- is the executable and its arguments.
chimera mcp add local --transport stdio -- node /path/to/server.js

# Remote server (Burnlite uses Streamable HTTP and OAuth).
chimera mcp add burnlite --transport http https://burnlite.dev/api/llm/mcp
```

Both commands save their connection under `mcpServers` in
`~/.chimera/config.json`. An interactive HTTP add offers to log in and test the
connection. Without a terminal, it saves the connection and prints
`chimera mcp login burnlite` instead of opening a browser. If login or testing
fails, the saved connection remains. Start a new session (or resume a session)
to discover current config; existing sessions do not hot-reload MCP servers.

Equivalent config, with optional stdio environment references and a trusted
allowlist shown for illustration:

```json
{
  "mcpServers": {
    "local": {
      "transport": "stdio",
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "API_KEY": "env:LOCAL_API_KEY" }
    },
    "burnlite": {
      "transport": "http",
      "url": "https://burnlite.dev/api/llm/mcp",
      "trustedTools": ["list_projects"]
    }
  }
}
```

Set `LOCAL_API_KEY` in the environment of the Chimera process; do not put its
value in the config file. `env` values must be `env:VARIABLE` references. For
HTTP servers that supply a pre-registered public client ID, set `clientId` in
the server entry. Remote URLs must use HTTPS; plain HTTP is allowed only for
loopback servers. Server names must start with a letter and contain only
letters, digits, `_`, or `-`. Do not enable `trustedTools` unless you intend to
authorize those tools without a prompt (see [`trustedTools`](#trustedtools)).

## Servers for one session

`--mcp-config` gives one session MCP servers without saving them. It is
accepted by `chimera`, `chimera run`, `chimera serve`, `chimera resume` and
`chimera continue`. The value is a JSON document shaped like the config file,
or `@` followed by the path of a file that holds one:

```bash
chimera --mcp-config '{"mcpServers":{"local":{"transport":"stdio","command":"node","args":["/path/to/server.js"]}}}'
chimera run --mcp-config @./servers.json "list my projects"
```

The servers are merged over the global `mcpServers` for that session: a server
with a new name is added, and one with the name of a global server replaces it.
`~/.chimera/config.json` is not changed. Every rule of the config file applies
(server names, `env:VARIABLE` references, HTTPS for remote URLs, `trustedTools`),
and a value that breaks one stops the command before a model is contacted, with
an error that names `--mcp-config`.

This is how a program that launches Chimera, such as an orchestrator, adds its
own tools to the sessions it starts. A stdio server defined this way receives
Chimera's environment when its entry has an `env` map, so `{"SESSION":
"env:SESSION"}` passes a variable the launcher set. Subagents started with
`spawn_agent` read the global config only and do not receive these servers.
`chimera mcp list`, `tools`, `call`, `login` and `logout` also act on the
global config only.

## Inspect, call, and manage

```bash
chimera mcp list                         # connection and auth status; no tokens
chimera mcp tools burnlite               # discover tool names and descriptions
chimera mcp call burnlite list_projects --args '{}'
chimera mcp login burnlite                # authorize or repair HTTP OAuth
chimera mcp logout burnlite               # delete local credentials; keep config
chimera mcp remove burnlite               # delete config and local credentials
```

`mcp call` is a human-driven invocation, independent of a model run. Pass a
JSON **object** to `--args`, quoted for your shell. In a terminal, the CLI asks
for permission before the call unless an allow rule or trusted-tool entry
already permits it. Without a terminal, it fails closed unless an explicit
allow rule or `trustedTools` permits the call. `mcp list` checks connection and
stored auth status; `login required` means credentials are absent, while an
unavailable connection may have other causes. Configuration alone allows
connection and discovery, **not** tool execution.

The agent sees registered tools as `mcp_<server>_<encoded-tool-name>`; the TUI
shows readable labels such as `burnlite / add_task_to_project` instead of encoded
IDs. Use the **original** server tool name, such as `list_projects`, for `mcp call` and
`trustedTools`. Tool availability is filtered by the active mode and any
subagent tool allowlist. Subagents use their own connections and do not inherit
an interactive approval from their parent. Calls return bounded text and
structured content; image, binary, and unknown content are reported as such,
not silently converted to text. Server-side tool errors are surfaced as errors.

Tool middleware revalidates inputs using JSON Schema 2020-12 (MCP's default
when `$schema` is absent) or explicitly declared draft-07. This validation
preserves schema constraints and local references; it does not fetch remote
`$ref` targets or unknown dialects. Unsupported dialects and unresolved references
fail validation before permission approval or server execution. Discovery with
`mcp tools` alone does not exercise agent-side input validation.

## OAuth and credentials

For Burnlite, run `chimera mcp login burnlite` in a terminal where you can open
a browser and receive the loopback callback. Chimera uses OAuth authorization
code with PKCE; it prints an authorization URL so you can open it manually if
the browser does not launch. The callback uses `http://localhost:3119/callback`
and listens only on the local loopback interface. If port 3119 is in use, close
the other login and retry. Login can register a client dynamically, or use a configured
`clientId` for servers that support pre-registered clients. Chimera stores
registration and access/refresh credentials per server and exact URL under
`~/.chimera/mcp-auth/`, with owner-only permissions, separate from
`config.json`. Do not paste authorization URLs or credentials into issue
reports or logs.

Agent runs do not open a browser. If an access token expires and a refresh
token is saved, Chimera refreshes it automatically on the next request and
persists any rotated refresh token. If the refresh token is missing, expired,
or revoked, run `chimera mcp login <server>` yourself and retry. `mcp logout` clears local
credentials without removing the server; `mcp remove` clears both. No live
Burnlite account is needed for local configuration.

## Permissions and sandbox risk

**MCP runs on the host even when `--sandbox` is enabled.** A local stdio
server launches a host process with your user privileges; remote tools send
requests from the host and can change external data. Docker filesystem and
network restrictions do not confine these calls, including with
`--sandbox-network none` or overlay/ephemeral mode.

Every MCP call passes a separate MCP permission gate before the server receives
it. Host `autoApprove` does not grant MCP calls. An interactive request shows
the server, tool, target, and a bounded, redacted argument preview. Global
rules live in `~/.chimera/permissions.json`; project rules live in
`<cwd>/.chimera/permissions.json`. New sessions load these rules at creation.
Headless runs and subagents without an interactive approver deny by default
when no rule or `trustedTools` entry allows the call. The permission audit
records decisions without raw argument bodies or secrets.

### What decides an MCP call

The gate checks these in order and stops at the first that applies:

1. A **deny rule** that matches `<server>/<tool>` denies the call.
2. An **allow rule** that matches `<server>/<tool>` allows it.
3. The server's **`trustedTools`** list allows it, unless a `!` entry
   excludes the tool.
4. Otherwise the call **asks**: mods, hooks, the approval reviewer (when
   `approvalReviewer.enabled` is true), then you. A headless run denies.

Nothing is trusted by default. A server is trusted only by a rule you save or
write, or by a `trustedTools` entry in its config.

### Trusting a whole server

At the prompt, **Allow all `<server>` tools…** (key `S`) saves the glob rule
`<server>/*` for the session, the project, or all projects. **Allow pattern…**
also takes a glob, but a remembered MCP pattern must name the server that
asked and cover the call being approved. Any other pattern (`**`, `*/*`,
another server) is saved as the exact `<server>/<tool>`.

You can write the same rule by hand, under `rules` in
`~/.chimera/permissions.json` or `<cwd>/.chimera/permissions.json`:

```json
{
  "tool": "mcp",
  "target": "host",
  "pattern": "burnlite/*",
  "patternKind": "glob",
  "decision": "allow",
  "createdAt": 1764000000000
}
```

A hand-written rule may use any glob; `*` does not cross the `/`, so
`burnlite/*` does not match `burnlite-x/…`. An exact deny rule, such as
`burnlite/delete_task`, still beats a `burnlite/*` allow.

### `trustedTools`

Each `trustedTools` entry is a glob over the server's **original** tool name:

| Entry | Trusts |
| --- | --- |
| `"list_projects"` | that tool |
| `"list_*"` | every tool whose name starts with `list_` |
| `"*"` | every tool of the server |
| `"!delete_*"` | nothing; excludes matching tools from the other entries |

`["*", "!delete_*"]` runs every tool without a prompt except the delete
tools, which ask (or are denied in a headless run). Use a deny rule, not a
`!` entry, for a tool that must never run. A mod manifest's `mcpServers`
entries and `--mcp-config` take the same `trustedTools` entries.

A `trustedTools` list authorizes its tools in **all** modes where those tools
are available, including headless runs and subagents. Treat an entry,
especially `*`, as ongoing permission to act with your host credentials.

## Connection recovery

A closed MCP connection no longer requires a session reload. Chimera discards
that connection and its tool catalog. A later, new call reconnects and
rediscovers the server. Concurrent callers share one connection and discovery.
This applies to ordinary and mod-bundled servers. It does not hot-reload server
configuration or add newly discovered tools to the session's registered tool list.

Chimera **never automatically replays a failed tool call**. A disconnected,
timed-out, cancelled, or oversized call can have executed on the server before
its reply was lost. Check the result before retrying a mutation. After a
receive-limit error, request less output instead of repeating the same large
read. Stdio diagnostics are consumed and discarded so a verbose server cannot
block its own response pipe; diagnostic text is not added to agent errors.

HTTP session expiry (404) discards the old connection, but does not replay the
request. A new request initializes a new session. Token refresh after a 401
continues to use the existing OAuth flow. Closing a Chimera session also closes
initializing MCP connections; disposed managers cannot start another child.

## Troubleshooting

- **Server unavailable:** Check `chimera mcp list`, then verify the stdio
  executable, its arguments and referenced environment variables, or the HTTP
  URL and network access. Other healthy servers can still load. Stdio servers
  are separate child processes per session; stop the session to close them.
- **Authorization required:** Chimera refreshes expired access tokens when a
  valid refresh token is saved. If refresh fails or no refresh token is saved,
  run `chimera mcp login <server>` in a terminal and retry. If you changed the remote resource URL, log in again;
  credentials are keyed to the exact URL. Check that the browser can reach
  Chimera's local callback. Login failures do not remove the server config.
- **Call denied:** Approve interactively, save a `<server>/*` rule, or, only
  for tools you intentionally trust, add the original tool name (or a glob)
  to that server's `trustedTools`. An explicit deny rule takes precedence;
  `--auto-approve host` does not help.
- **Tool missing:** Run `chimera mcp tools <server>` to see original tool
  names. Start or resume a session after changing config, and check the mode
  and subagent allowlist. Only MCP tools are exposed, not resources or prompts.
- **Connection closed:** A new call reconnects automatically. The failed call
  was not retried. Check the result before retrying a mutation.
- **Timeout, oversized schema/result, or server error:** Check server health
  and reduce the requested output. Tool discovery, calls, schema sizes, tool
  counts, and results have limits; failures are reported rather than treated
  as empty success.

## Many tools, small context

Every registered MCP tool adds its name, description and input schema to each
request. At session start Chimera estimates that size (four characters a
token) for all servers together:

- **Up to 10% of the model's context window:** every tool is registered, as
  described above.
- **Over 10%:** no MCP tool is registered. The agent gets `tool_search`
  instead. Its description names the servers and their tool counts. The agent
  calls it with a few words (`create issue`); the best matches come back with
  their descriptions and are registered for the rest of the session, so the
  agent can call them from its next step. An empty query lists the servers.

A tool that `tool_search` registered stays registered across mode and model
changes; a mode's `tools` allowlist still applies to it, and to `tool_search`
itself. Each search that registers something changes the tool list, so the
provider's prompt cache starts again once for that step. Approval works the
same either way: `trustedTools` and the permission prompt apply when the tool
is called, not when it is found.

The decision is made once, for the model the session starts on. A large
model with a large window usually stays under the limit; the same servers
with a small local model usually go over it.

