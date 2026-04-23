#!/usr/bin/env node

/**
 * Smoke test — exercises all storage functions directly.
 * Run: node src/smoke-test.js
 */

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

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

console.log('--- create_scope_contract ---');
const c1 = createContract('agent-a', {
  allowed_tools: ['Read', 'Grep', 'WebSearch'],
  forbidden_tools: ['Bash'],
  allowed_files: ['src/lib/*', 'core/kb/'],
  max_delegations: 2,
  description: 'Research agent',
});
assert(c1.contract_id.startsWith('sc_'), 'contract_id format');
assert(c1.agent_id === 'agent-a', 'agent_id stored');
assert(c1.allowed_tools.length === 3, 'allowed_tools stored');
assert(c1.forbidden_tools[0] === 'Bash', 'forbidden_tools stored');

console.log('\n--- validate_action ---');
const v1 = validateAction('agent-a', 'Read', 'src/lib/utils.js');
assert(v1.allowed === true, 'allowed tool + allowed file = allowed');

const v2 = validateAction('agent-a', 'Bash', undefined);
assert(v2.allowed === false, 'forbidden tool = blocked');
assert(v2.reason.includes('forbidden'), 'reason mentions forbidden');

const v3 = validateAction('agent-a', 'Read', '/etc/passwd');
assert(v3.allowed === false, 'file outside scope = blocked');

const v4 = validateAction('agent-a', 'Write', undefined);
assert(v4.allowed === false, 'tool not in allowed list = blocked');

const v5 = validateAction('unknown-agent', 'Read', undefined);
assert(v5.allowed === false, 'no contract = blocked');

console.log('\n--- detect_delegation_loop ---');
const loop1 = detectDelegationLoop([
  { from: 'A', to: 'B', task: 'research' },
  { from: 'B', to: 'C', task: 'analyze' },
  { from: 'C', to: 'A', task: 'summarize' },
]);
assert(loop1.is_loop === true, 'circular A->B->C->A detected');
assert(loop1.cycle.includes('A'), 'cycle includes A');

const loop2 = detectDelegationLoop([
  { from: 'A', to: 'B', task: 'research' },
  { from: 'B', to: 'C', task: 'analyze' },
]);
assert(loop2.is_loop === false, 'linear chain = no loop');

const loop3 = detectDelegationLoop([]);
assert(loop3.is_loop === false, 'empty chain = no loop');

console.log('\n--- log_agent_action ---');
const l1 = logAction('agent-a', 'tool_call', { tool_name: 'Read', args: { file: 'x.js' } });
assert(l1.logged === true, 'action logged');
assert(l1.total_actions === 1, 'count is 1');

logAction('agent-a', 'delegation', { to: 'agent-b', task: 'sub-task' });
logAction('agent-a', 'tool_call', { tool_name: 'Grep', args: { pattern: 'foo' } });
logAction('agent-a', 'completion', { result: 'done' });

console.log('\n--- detect_work_duplication ---');
// Log similar actions for agent-b
createContract('agent-b', {
  allowed_tools: ['Read', 'Grep'],
  forbidden_tools: [],
  allowed_files: [],
  max_delegations: 3,
  description: 'Another agent',
});
logAction('agent-b', 'tool_call', { tool_name: 'Read', args: { file: 'x.js' } });
logAction('agent-b', 'tool_call', { tool_name: 'Grep', args: { pattern: 'foo' } });

const dup = detectWorkDuplication();
assert(dup.duplicates_found === true, 'duplicates detected');
assert(dup.duplicate_pairs.length >= 1, 'at least 1 duplicate pair');
assert(dup.duplicate_pairs[0].agent_a === 'agent-a', 'pair includes agent-a');

console.log('\n--- get_compliance_report ---');
const report = getComplianceReport();
assert(report.total_agents >= 2, 'report covers 2+ agents');
const agentAReport = report.agents.find(a => a.agent_id === 'agent-a');
assert(agentAReport.total_actions === 4, 'agent-a has 4 actions');
assert(agentAReport.delegation_count === 1, 'agent-a has 1 delegation');
assert(typeof agentAReport.scope_utilization_percent === 'number', 'scope utilization is numeric');

console.log('\n--- listContracts ---');
const all = listContracts();
assert(all.length === 2, '2 contracts total');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
