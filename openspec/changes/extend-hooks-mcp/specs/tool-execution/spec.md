## ADDED Requirements

### Requirement: Deferred MCP tools
At session start Chimera SHALL estimate the size of all MCP tool schemas at four characters a token. When that size is more than 10% of the session model's context window, Chimera SHALL NOT register the MCP tools and SHALL register a `tool_search` tool instead. When it is 10% or less, Chimera SHALL register every MCP tool and SHALL NOT register `tool_search`.

#### Scenario: Under the limit
- **WHEN** the MCP tool schemas take 4% of the context window
- **THEN** every MCP tool is registered and `tool_search` is not

#### Scenario: Over the limit
- **WHEN** the MCP tool schemas take 18% of the context window
- **THEN** no MCP tool is registered and `tool_search` is

### Requirement: Tool search
`tool_search` SHALL take a query and return the deferred MCP tools that match it best, with their names and descriptions, and SHALL register the returned tools for the rest of the session, so that the model can call them from its next step. A search for tools that are registered already SHALL register nothing. With an empty query it SHALL list the servers and how many tools each has, and SHALL register nothing. The description of `tool_search` SHALL name the servers whose tools are deferred.

#### Scenario: Search and call
- **WHEN** the model calls `tool_search` with `create issue` and a deferred tool `tracker__create_issue` exists
- **THEN** the result lists `tracker__create_issue`, and the model can call it in the next step

#### Scenario: No match
- **WHEN** the model calls `tool_search` with a query that matches no tool
- **THEN** the result says so and lists the servers

#### Scenario: Server overview
- **WHEN** the model calls `tool_search` with an empty query
- **THEN** the result lists each server with its tool count, and no tool is registered
