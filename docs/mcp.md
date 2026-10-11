# MCP tools

Chimera connects to local MCP servers over stdio and remote servers over MCP
Streamable HTTP. It discovers **tools** when a session starts and exposes them
to the agent as namespaced tools. MCP resources and prompts, legacy SSE, manual
bearer tokens, and OAuth device flow are not supported. Saved MCP configuration
is global only; a launch flag can add servers for one session (see
[Servers for one session](#servers-for-one-session)). There is no project-local
MCP config, in-session hot reload, or TUI `/mcp` screen.

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
authorize those tools without a prompt (see below).

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
the server, tool, target, and a bounded, redacted argument preview; you can
allow one call or remember a per-server/per-tool rule for this session, this
project, or all projects. Global rules live in `~/.chimera/permissions.json`;
project rules live in `<cwd>/.chimera/permissions.json`. New sessions load these
rules at creation. Headless runs and subagents without an interactive approver
deny by default when no rule allows the call. An explicit
`trustedTools` list on a server authorizes the named tools in **all** modes
where those tools are available, including headless runs and subagents;
explicit deny rules still take priority. Treat a trusted entry as ongoing
permission to act with your host credentials, not as a way to trust the whole
server. The permission audit records decisions without raw argument bodies or
secrets.

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
- **Call denied:** Approve interactively or, only for tools you intentionally
  trust, add the original tool name to that server's `trustedTools`. An
  explicit deny rule takes precedence; `--auto-approve host` does not help.
- **Tool missing:** Run `chimera mcp tools <server>` to see original tool
  names. Start or resume a session after changing config, and check the mode
  and subagent allowlist. Only MCP tools are exposed, not resources or prompts.
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

