// ═══════════════════════════════════════════
// Storage layer for scope contracts and action logs
// Backed by SQLite via src/db.js
// In-memory action log retained (rolling 100-entry window per agent)
// ═══════════════════════════════════════════

import {
  dbUpsertScope,
  dbGetScope,
  dbGetAllScopes,
  dbInsertViolation,
  dbGetViolationsByAgent,
  dbCountViolations,
} from './db.js';

/** @type {Map<string, object[]>} agent_id -> action log entries (in-memory, rolling) */
const actionLogs = new Map();

// ═══════════════════════════════════════════
// SCOPE CONTRACTS
// ═══════════════════════════════════════════

export function createContract(agentId, opts) {
  const contractId = `sc_${Date.now()}_${agentId}`;
  const createdAt  = new Date().toISOString();

  const restrictions = {
    forbidden_tools:   opts.forbidden_tools   || [],
    max_delegations:   opts.max_delegations   ?? 3,
    description:       opts.description       || '',
    delegation_count:  0,
  };

  dbUpsertScope(
    contractId,
    agentId,
    opts.allowed_files || [],
    opts.allowed_tools || [],
    restrictions,
    createdAt,
  );

  return _buildContract(contractId, agentId, opts.allowed_files || [], opts.allowed_tools || [], restrictions, createdAt);
}

export function getContract(agentId) {
  const row = dbGetScope(agentId);
  if (!row) return null;
  return _rowToContract(row);
}

export function listContracts() {
  return dbGetAllScopes().map(_rowToContract);
}

// ═══════════════════════════════════════════
// ACTION VALIDATION
// ═══════════════════════════════════════════

/**
 * Check if an action is allowed by the agent's scope contract.
 * Identical signature to the original.
 */
export function validateAction(agentId, toolName, filePath) {
  const contract = getContract(agentId);

  if (!contract) {
    return {
      allowed: false,
      reason: `No scope contract found for agent "${agentId}". Register a contract first.`,
      contract_id: null,
    };
  }

  // Check forbidden tools first (takes priority)
  if (contract.forbidden_tools.length > 0 && contract.forbidden_tools.includes(toolName)) {
    const detail = `Tool "${toolName}" is explicitly forbidden for agent "${agentId}".`;
    dbInsertViolation(contract.contract_id, agentId, 'forbidden_tool', detail);
    return { allowed: false, reason: detail, contract_id: contract.contract_id };
  }

  // Check allowed tools (if list is non-empty, tool must be in it)
  if (contract.allowed_tools.length > 0 && !contract.allowed_tools.includes(toolName)) {
    const detail = `Tool "${toolName}" is not in the allowed tools list for agent "${agentId}". Allowed: [${contract.allowed_tools.join(', ')}].`;
    dbInsertViolation(contract.contract_id, agentId, 'disallowed_tool', detail);
    return { allowed: false, reason: detail, contract_id: contract.contract_id };
  }

  // Check file path restrictions
  if (filePath && contract.allowed_files.length > 0) {
    const fileAllowed = contract.allowed_files.some((pattern) => {
      if (pattern.endsWith('*'))  return filePath.startsWith(pattern.slice(0, -1));
      if (pattern.endsWith('/'))  return filePath.startsWith(pattern);
      return filePath === pattern;
    });

    if (!fileAllowed) {
      const detail = `File "${filePath}" is outside the allowed file scope for agent "${agentId}". Allowed patterns: [${contract.allowed_files.join(', ')}].`;
      dbInsertViolation(contract.contract_id, agentId, 'disallowed_file', detail);
      return { allowed: false, reason: detail, contract_id: contract.contract_id };
    }
  }

  return {
    allowed: true,
    reason: 'Action is within scope.',
    contract_id: contract.contract_id,
  };
}

// ═══════════════════════════════════════════
// DELEGATION LOOP DETECTION
// ═══════════════════════════════════════════

/**
 * Detect circular delegation in a chain.
 * Uses visited-set approach to find cycles.
 */
export function detectDelegationLoop(chain) {
  if (!chain || chain.length === 0) {
    return { is_loop: false, cycle: [], suggestion: 'No delegation chain provided.' };
  }

  const visited = new Map(); // agent -> index in chain where first seen

  for (let i = 0; i < chain.length; i++) {
    const from = chain[i].from;
    const to   = chain[i].to;

    if (!visited.has(from)) {
      visited.set(from, i);
    }

    if (visited.has(to)) {
      // Found a cycle — extract it
      const cycleStart  = visited.get(to);
      const cycleAgents = [];
      for (let j = cycleStart; j <= i; j++) {
        cycleAgents.push(chain[j].from);
      }
      cycleAgents.push(to);

      return {
        is_loop: true,
        cycle: cycleAgents,
        suggestion: `Agent "${to}" already appeared at step ${cycleStart + 1}. Break the loop by having one agent execute the task directly instead of delegating back to "${to}".`,
      };
    }
  }

  // Check delegation limits
  const delegationCounts = new Map();
  for (const link of chain) {
    const count    = (delegationCounts.get(link.from) || 0) + 1;
    delegationCounts.set(link.from, count);

    const contract = getContract(link.from);
    if (contract && count > contract.max_delegations) {
      return {
        is_loop: false,
        cycle: [],
        suggestion: `Agent "${link.from}" has exceeded its max delegation limit (${contract.max_delegations}). Current count: ${count}. The agent should execute the task directly.`,
        delegation_limit_exceeded: true,
        agent_id:      link.from,
        current_count: count,
        max_allowed:   contract.max_delegations,
      };
    }
  }

  return {
    is_loop: false,
    cycle: [],
    suggestion: `Chain of ${chain.length} delegation(s) looks clean. No circular patterns detected.`,
  };
}

// ═══════════════════════════════════════════
// ACTION LOGGING
// ═══════════════════════════════════════════

const MAX_LOG_ENTRIES = 100;

export function logAction(agentId, actionType, details) {
  if (!actionLogs.has(agentId)) {
    actionLogs.set(agentId, []);
  }

  const log   = actionLogs.get(agentId);
  const entry = {
    agent_id:    agentId,
    action_type: actionType,
    details:     details || {},
    timestamp:   new Date().toISOString(),
  };

  log.push(entry);

  // Rolling window
  if (log.length > MAX_LOG_ENTRIES) {
    log.splice(0, log.length - MAX_LOG_ENTRIES);
  }

  // Track delegations against contract in DB
  if (actionType === 'delegation') {
    const row = dbGetScope(agentId);
    if (row) {
      const restrictions = { ...row.restrictions, delegation_count: (row.restrictions.delegation_count || 0) + 1 };
      dbUpsertScope(row.scope_id, agentId, row.allowed_files, row.allowed_tools, restrictions, row.created_at);
    }
  }

  return {
    logged:        true,
    agent_id:      agentId,
    action_type:   actionType,
    total_actions: log.length,
    timestamp:     entry.timestamp,
  };
}

// ═══════════════════════════════════════════
// COMPLIANCE REPORT
// ═══════════════════════════════════════════

export function getComplianceReport() {
  const allContracts = listContracts();
  const allAgentIds  = new Set([
    ...allContracts.map((c) => c.agent_id),
    ...actionLogs.keys(),
  ]);

  const agents = [];

  for (const agentId of allAgentIds) {
    const contract = getContract(agentId);
    const logs     = actionLogs.get(agentId) || [];

    let violations       = dbCountViolations(agentId);
    let delegationCount  = 0;
    const toolsUsed      = new Set();

    for (const entry of logs) {
      if (entry.action_type === 'delegation') {
        delegationCount++;
      }
      if (entry.action_type === 'tool_call' && entry.details.tool_name) {
        toolsUsed.add(entry.details.tool_name);
      }
    }

    // Scope utilization: % of allowed tools actually used
    let scopeUtilization = 0;
    if (contract && contract.allowed_tools.length > 0) {
      const usedAllowed = contract.allowed_tools.filter((t) => toolsUsed.has(t));
      scopeUtilization  = Math.round((usedAllowed.length / contract.allowed_tools.length) * 100);
    }

    agents.push({
      agent_id:                 agentId,
      has_contract:             !!contract,
      total_actions:            logs.length,
      violations,
      delegation_count:         delegationCount,
      max_delegations:          contract ? contract.max_delegations : null,
      scope_utilization_percent: scopeUtilization,
      tools_used:               Array.from(toolsUsed),
    });
  }

  return {
    total_agents:     agents.length,
    total_violations: agents.reduce((s, a) => s + a.violations, 0),
    agents,
    generated_at:     new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════
// WORK DUPLICATION DETECTION
// ═══════════════════════════════════════════

/**
 * Compare action logs across agents to find duplicated work.
 */
export function detectWorkDuplication() {
  const agentIds  = Array.from(actionLogs.keys());
  const duplicates = [];

  for (let i = 0; i < agentIds.length; i++) {
    for (let j = i + 1; j < agentIds.length; j++) {
      const logsA = actionLogs.get(agentIds[i]);
      const logsB = actionLogs.get(agentIds[j]);

      const toolCallsA = logsA.filter((e) => e.action_type === 'tool_call');
      const toolCallsB = logsB.filter((e) => e.action_type === 'tool_call');

      for (const a of toolCallsA) {
        for (const b of toolCallsB) {
          if (!a.details.tool_name || !b.details.tool_name) continue;
          if (a.details.tool_name !== b.details.tool_name) continue;

          const similarity = computeArgSimilarity(a.details.args, b.details.args);
          if (similarity >= 0.7) {
            duplicates.push({
              agent_a:    agentIds[i],
              agent_b:    agentIds[j],
              action:     a.details.tool_name,
              similarity: Math.round(similarity * 100),
              args_a:     a.details.args,
              args_b:     b.details.args,
              timestamps: { a: a.timestamp, b: b.timestamp },
            });
          }
        }
      }
    }
  }

  // Deduplicate: keep only the highest similarity per agent pair + tool
  const seen   = new Set();
  const unique = [];
  for (const d of duplicates) {
    const key = `${d.agent_a}|${d.agent_b}|${d.action}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(d);
    }
  }

  return {
    duplicates_found: unique.length > 0,
    duplicate_count:  unique.length,
    duplicate_pairs:  unique,
    suggestion: unique.length > 0
      ? `Found ${unique.length} potential work duplication(s). Consider assigning non-overlapping scopes or consolidating tasks.`
      : 'No work duplication detected across agents.',
    generated_at: new Date().toISOString(),
  };
}

// ─── Internal helpers ─────────────────────────

function computeArgSimilarity(argsA, argsB) {
  if (!argsA && !argsB) return 1;
  if (!argsA || !argsB) return 0;

  const strA = JSON.stringify(argsA);
  const strB = JSON.stringify(argsB);
  if (strA === strB) return 1;

  const keysA   = Object.keys(argsA);
  const keysB   = Object.keys(argsB);
  const allKeys = new Set([...keysA, ...keysB]);

  if (allKeys.size === 0) return 1;

  let matchingValues = 0;
  for (const key of allKeys) {
    if (key in argsA && key in argsB) {
      const valA = JSON.stringify(argsA[key]);
      const valB = JSON.stringify(argsB[key]);
      if (valA === valB) {
        matchingValues++;
      } else if (typeof argsA[key] === 'string' && typeof argsB[key] === 'string') {
        const shorter = Math.min(argsA[key].length, argsB[key].length);
        const longer  = Math.max(argsA[key].length, argsB[key].length);
        if (longer > 0 && (argsA[key].includes(argsB[key]) || argsB[key].includes(argsA[key]))) {
          matchingValues += shorter / longer;
        }
      }
    }
  }

  return matchingValues / allKeys.size;
}

function _buildContract(contractId, agentId, allowedFiles, allowedTools, restrictions, createdAt) {
  return {
    contract_id:      contractId,
    agent_id:         agentId,
    allowed_tools:    allowedTools,
    forbidden_tools:  restrictions.forbidden_tools  || [],
    allowed_files:    allowedFiles,
    max_delegations:  restrictions.max_delegations  ?? 3,
    description:      restrictions.description      || '',
    created_at:       createdAt,
    delegation_count: restrictions.delegation_count || 0,
  };
}

function _rowToContract(row) {
  return _buildContract(
    row.scope_id,
    row.agent_id,
    row.allowed_files,
    row.allowed_tools,
    row.restrictions,
    row.created_at,
  );
}
