# scope-guard-mcp

MCP server that enforces multi-agent scope boundaries. Prevents scope drift, work duplication, and infinite delegation loops in agentic systems.

## Tools

| Tool | Purpose |
|------|---------|
| `create_scope_contract` | Define agent boundaries: allowed/forbidden tools, file access patterns, delegation limits |
| `validate_action` | Pre-flight check — is a tool call or file access within scope? |
| `detect_delegation_loop` | Analyze delegation chains for circular patterns |
| `log_agent_action` | Track agent actions for compliance monitoring |
| `get_compliance_report` | Per-agent summary: actions, violations, delegation count, scope utilization % |
| `detect_work_duplication` | Find agents doing the same work across action logs |

## Resources

| URI | Description |
|-----|-------------|
| `scope-guard://contracts` | All active scope contracts |

## Install

```bash
npm install
node src/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "scope-guard": {
      "command": "npx",
      "args": ["scope-guard-mcp"]
    }
  }
}
```

## License

MIT
