// ═══════════════════════════════════════════
// In-memory storage for scope contracts and action logs
// ═══════════════════════════════════════════

/** @type {Map<string, object>} agent_id -> scope contract */
const contracts = new Map();

/** @type {Map<string, object[]>} agent_id -> action log entries */
const actionLogs = new Map();

// ═══════════════════════════════════════════
// SCOPE CONTRACTS
// ═══════════════════════════════════════════

export function createContract(agentId, opts) {
  const contract = {
    contract_id: `sc_${Date.now()}_${agentId}`,
    agent_id: agentId,
    allowed_tools: opts.allowed_tools || [],
    forbidden_tools: opts.forbidden_tools || [],
    allowed_files: opts.allowed_files || [],
    max_delegations: opts.max_delegations ?? 3,
    description: opts.description || '',
    created_at: new Date().toISOString(),
    delegation_count: 0,
  };
  contracts.set(agentId, contract);
  return contract;
}

export function getContract(agentId) {
  return contracts.get(agentId) || null;
}

export function listContracts() {
  return Array.from(contracts.values());
}

// ═══════════════════════════════════════════
// ACTION VALIDATION
// ═══════════════════════════════════════════

/**
 * Check if an action is allowed by the agent's scope contract.
 */
export function validateAction(agentId, toolName, filePath) {
  const contract = contracts.get(agentId);
  if (!contract) {
    return {
      allowed: false,
      reason: `No scope contract found for agent "${agentId}". Register a contract first.`,
      contract_id: null,
    };
  }

  // Check forbidden tools first (takes priority)
  if (contract.forbidden_tools.length > 0 && contract.forbidden_tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is explicitly forbidden for agent "${agentId}".`,
      contract_id: contract.contract_id,
    };
  }

  // Check allowed tools (if list is non-empty, tool must be in it)
  if (contract.allowed_tools.length > 0 && !contract.allowed_tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the allowed tools list for agent "${agentId}". Allowed: [${contract.allowed_tools.join(', ')}].`,
      contract_id: contract.contract_id,
    };
  }

  // Check file path restrictions
  if (filePath && contract.allowed_files.length > 0) {
    const fileAllowed = contract.allowed_files.some((pattern) => {
      // Support glob-like prefix matching: "src/lib/*" matches "src/lib/foo.js"
      if (pattern.endsWith('*')) {
        return filePath.startsWith(pattern.slice(0, -1));
      }
      // Support directory matching: "src/lib/" matches "src/lib/foo.js"
      if (pattern.endsWith('/')) {
        return filePath.startsWith(pattern);
      }
      // Exact match
      return filePath === pattern;
    });

    if (!fileAllowed) {
      return {
        allowed: false,
        reason: `File "${filePath}" is outside the allowed file scope for agent "${agentId}". Allowed patterns: [${contract.allowed_files.join(', ')}].`,
        contract_id: contract.contract_id,
      };
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
    const to = chain[i].to;

    if (!visited.has(from)) {
      visited.set(from, i);
    }

    if (visited.has(to)) {
      // Found a cycle — extract it
      const cycleStart = visited.get(to);
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
    const count = (delegationCounts.get(link.from) || 0) + 1;
    delegationCounts.set(link.from, count);

    const contract = contracts.get(link.from);
    if (contract && count > contract.max_delegations) {
      return {
        is_loop: false,
        cycle: [],
        suggestion: `Agent "${link.from}" has exceeded its max delegation limit (${contract.max_delegations}). Current count: ${count}. The agent should execute the task directly.`,
        delegation_limit_exceeded: true,
        agent_id: link.from,
        current_count: count,
        max_allowed: contract.max_delegations,
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

  const log = actionLogs.get(agentId);
  const entry = {
    agent_id: agentId,
    action_type: actionType,
    details: details || {},
    timestamp: new Date().toISOString(),
  };

  log.push(entry);

  // Rolling window
  if (log.length > MAX_LOG_ENTRIES) {
    log.splice(0, log.length - MAX_LOG_ENTRIES);
  }

  // Track delegations against contract
  if (actionType === 'delegation') {
    const contract = contracts.get(agentId);
    if (contract) {
      contract.delegation_count += 1;
    }
  }

  return {
    logged: true,
    agent_id: agentId,
    action_type: actionType,
    total_actions: log.length,
    timestamp: entry.timestamp,
  };
}

// ═══════════════════════════════════════════
// COMPLIANCE REPORT
// ═══════════════════════════════════════════

export function getComplianceReport() {
  const allAgentIds = new Set([...contracts.keys(), ...actionLogs.keys()]);
  const agents = [];

  for (const agentId of allAgentIds) {
    const contract = contracts.get(agentId);
    const logs = actionLogs.get(agentId) || [];

    // Count violations by replaying actions against contract
    let violations = 0;
    let delegationCount = 0;
    const toolsUsed = new Set();

    for (const entry of logs) {
      if (entry.action_type === 'delegation') {
        delegationCount++;
      }
      if (entry.action_type === 'tool_call' && entry.details.tool_name) {
        toolsUsed.add(entry.details.tool_name);
        if (contract) {
          const result = validateAction(agentId, entry.details.tool_name, entry.details.file_path);
          if (!result.allowed) violations++;
        }
      }
      if (entry.action_type === 'file_access' && entry.details.file_path && contract) {
        // Check file access against allowed files
        if (contract.allowed_files.length > 0) {
          const fileAllowed = contract.allowed_files.some((p) => {
            if (p.endsWith('*')) return entry.details.file_path.startsWith(p.slice(0, -1));
            if (p.endsWith('/')) return entry.details.file_path.startsWith(p);
            return entry.details.file_path === p;
          });
          if (!fileAllowed) violations++;
        }
      }
    }

    // Scope utilization: % of allowed tools actually used
    let scopeUtilization = 0;
    if (contract && contract.allowed_tools.length > 0) {
      const usedAllowed = contract.allowed_tools.filter((t) => toolsUsed.has(t));
      scopeUtilization = Math.round((usedAllowed.length / contract.allowed_tools.length) * 100);
    }

    agents.push({
      agent_id: agentId,
      has_contract: !!contract,
      total_actions: logs.length,
      violations,
      delegation_count: delegationCount,
      max_delegations: contract ? contract.max_delegations : null,
      scope_utilization_percent: scopeUtilization,
      tools_used: Array.from(toolsUsed),
    });
  }

  return {
    total_agents: agents.length,
    total_violations: agents.reduce((s, a) => s + a.violations, 0),
    agents,
    generated_at: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════
// WORK DUPLICATION DETECTION
// ═══════════════════════════════════════════

/**
 * Compare action logs across agents to find duplicated work.
 * Two agents calling the same tool with similar arguments = potential duplication.
 */
export function detectWorkDuplication() {
  const agentIds = Array.from(actionLogs.keys());
  const duplicates = [];

  for (let i = 0; i < agentIds.length; i++) {
    for (let j = i + 1; j < agentIds.length; j++) {
      const logsA = actionLogs.get(agentIds[i]);
      const logsB = actionLogs.get(agentIds[j]);

      // Compare tool_call actions
      const toolCallsA = logsA.filter((e) => e.action_type === 'tool_call');
      const toolCallsB = logsB.filter((e) => e.action_type === 'tool_call');

      for (const a of toolCallsA) {
        for (const b of toolCallsB) {
          if (!a.details.tool_name || !b.details.tool_name) continue;
          if (a.details.tool_name !== b.details.tool_name) continue;

          // Same tool — check argument similarity
          const similarity = computeArgSimilarity(a.details.args, b.details.args);
          if (similarity >= 0.7) {
            duplicates.push({
              agent_a: agentIds[i],
              agent_b: agentIds[j],
              action: a.details.tool_name,
              similarity: Math.round(similarity * 100),
              args_a: a.details.args,
              args_b: b.details.args,
              timestamps: { a: a.timestamp, b: b.timestamp },
            });
          }
        }
      }
    }
  }

  // Deduplicate: keep only the highest similarity per agent pair + tool
  const seen = new Set();
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
    duplicate_count: unique.length,
    duplicate_pairs: unique,
    suggestion: unique.length > 0
      ? `Found ${unique.length} potential work duplication(s). Consider assigning non-overlapping scopes or consolidating tasks.`
      : 'No work duplication detected across agents.',
    generated_at: new Date().toISOString(),
  };
}

/**
 * Compute similarity between two argument objects.
 * Returns 0..1 where 1 = identical.
 */
function computeArgSimilarity(argsA, argsB) {
  if (!argsA && !argsB) return 1;
  if (!argsA || !argsB) return 0;

  const strA = JSON.stringify(argsA);
  const strB = JSON.stringify(argsB);

  if (strA === strB) return 1;

  // Key overlap approach
  const keysA = Object.keys(argsA);
  const keysB = Object.keys(argsB);
  const allKeys = new Set([...keysA, ...keysB]);

  if (allKeys.size === 0) return 1;

  let matchingValues = 0;
  for (const key of allKeys) {
    if (key in argsA && key in argsB) {
      const valA = JSON.stringify(argsA[key]);
      const valB = JSON.stringify(argsB[key]);
      if (valA === valB) {
        matchingValues++;
      } else {
        // Partial credit for string similarity
        if (typeof argsA[key] === 'string' && typeof argsB[key] === 'string') {
          const shorter = Math.min(argsA[key].length, argsB[key].length);
          const longer = Math.max(argsA[key].length, argsB[key].length);
          if (longer > 0 && argsA[key].includes(argsB[key]) || argsB[key].includes(argsA[key])) {
            matchingValues += shorter / longer;
          }
        }
      }
    }
  }

  return matchingValues / allKeys.size;
}
