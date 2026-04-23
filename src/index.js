#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  createContract,
  getContract,
  listContracts,
  validateAction,
  detectDelegationLoop,
  logAction,
  getComplianceReport,
  detectWorkDuplication,
} from './storage.js';

const server = new McpServer({
  name: 'scope-guard-mcp',
  version: '0.1.0',
  description: 'Enforces multi-agent scope boundaries — prevents scope drift, work duplication, and infinite delegation loops',
});

// ═══════════════════════════════════════════
// 1. CREATE SCOPE CONTRACT
// ═══════════════════════════════════════════

server.tool(
  'create_scope_contract',
  'Define an agent\'s scope boundaries: allowed/forbidden tools, file access paths, and delegation limits.',
  {
    agent_id: z.string().describe('Unique identifier for the agent'),
    allowed_tools: z.array(z.string()).describe('List of tools the agent is permitted to use. Empty array means all tools allowed.'),
    forbidden_tools: z.array(z.string()).describe('List of tools the agent is explicitly forbidden from using. Takes priority over allowed_tools.'),
    allowed_files: z.array(z.string()).describe('File path patterns the agent can access. Supports glob-like prefixes (e.g. "src/lib/*"). Empty array means all files allowed.'),
    max_delegations: z.number().int().min(0).default(3).describe('Maximum number of delegations this agent can make before being told to execute directly (default 3)'),
    description: z.string().describe('Human-readable description of what this agent is responsible for'),
  },
  async (params) => {
    const contract = createContract(params.agent_id, {
      allowed_tools: params.allowed_tools,
      forbidden_tools: params.forbidden_tools,
      allowed_files: params.allowed_files,
      max_delegations: params.max_delegations,
      description: params.description,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          created: true,
          contract_id: contract.contract_id,
          agent_id: contract.agent_id,
          allowed_tools: contract.allowed_tools,
          forbidden_tools: contract.forbidden_tools,
          allowed_files: contract.allowed_files,
          max_delegations: contract.max_delegations,
          description: contract.description,
          created_at: contract.created_at,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// 2. VALIDATE ACTION
// ═══════════════════════════════════════════

server.tool(
  'validate_action',
  'Check if a proposed action (tool call, file access) is within an agent\'s scope contract. Call this BEFORE the agent executes.',
  {
    agent_id: z.string().describe('Agent identifier to validate against'),
    tool_name: z.string().describe('Name of the tool the agent wants to call'),
    file_path: z.string().optional().describe('File path the agent wants to access (optional)'),
  },
  async (params) => {
    const result = validateAction(params.agent_id, params.tool_name, params.file_path);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// 3. DETECT DELEGATION LOOP
// ═══════════════════════════════════════════

server.tool(
  'detect_delegation_loop',
  'Check a delegation chain for circular patterns. Detects when agents delegate back to each other creating infinite loops.',
  {
    delegation_chain: z.array(z.object({
      from: z.string().describe('Agent that delegated the task'),
      to: z.string().describe('Agent that received the delegation'),
      task: z.string().describe('Description of the delegated task'),
    })).describe('Ordered list of delegation steps to analyze'),
  },
  async ({ delegation_chain }) => {
    const result = detectDelegationLoop(delegation_chain);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// 4. LOG AGENT ACTION
// ═══════════════════════════════════════════

server.tool(
  'log_agent_action',
  'Track what an agent is doing. Logs tool calls, delegations, file accesses, and completions for compliance monitoring and duplication detection.',
  {
    agent_id: z.string().describe('Agent identifier'),
    action_type: z.enum(['tool_call', 'delegation', 'file_access', 'completion']).describe('Type of action being performed'),
    details: z.record(z.any()).describe('Action details — for tool_call: {tool_name, args, file_path}; for delegation: {to, task}; for file_access: {file_path, operation}; for completion: {result}'),
  },
  async (params) => {
    const result = logAction(params.agent_id, params.action_type, params.details);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// 5. GET COMPLIANCE REPORT
// ═══════════════════════════════════════════

server.tool(
  'get_compliance_report',
  'Get a compliance summary for all agents: total actions, scope violations, delegation counts, and scope utilization percentage.',
  {},
  async () => {
    const report = getComplianceReport();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// 6. DETECT WORK DUPLICATION
// ═══════════════════════════════════════════

server.tool(
  'detect_work_duplication',
  'Find agents doing the same work. Compares action logs across all agents — if 2+ agents called the same tool with similar arguments, flags as potential duplication.',
  {},
  async () => {
    const result = detectWorkDuplication();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'contracts',
  'scope-guard://contracts',
  async () => {
    const allContracts = listContracts();

    return {
      contents: [{
        uri: 'scope-guard://contracts',
        mimeType: 'application/json',
        text: JSON.stringify({
          total: allContracts.length,
          contracts: allContracts.map((c) => ({
            contract_id: c.contract_id,
            agent_id: c.agent_id,
            description: c.description,
            allowed_tools_count: c.allowed_tools.length,
            forbidden_tools_count: c.forbidden_tools.length,
            allowed_files_count: c.allowed_files.length,
            max_delegations: c.max_delegations,
            delegation_count: c.delegation_count,
            created_at: c.created_at,
          })),
          generated_at: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Scope Guard MCP Server running on stdio');
}

main().catch(console.error);
