/**
 * Tests for scope-guard-mcp storage functions.
 * Uses node:test + node:assert/strict (no npm deps).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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

describe('createContract', () => {
  test('creates a contract with correct fields', () => {
    const c = createContract('test-agent-1', {
      allowed_tools: ['Read', 'Grep'],
      forbidden_tools: ['Bash'],
      allowed_files: ['src/*'],
      max_delegations: 2,
      description: 'Test agent',
    });
    assert.ok(c.contract_id.startsWith('sc_'));
    assert.equal(c.agent_id, 'test-agent-1');
    assert.deepEqual(c.allowed_tools, ['Read', 'Grep']);
    assert.deepEqual(c.forbidden_tools, ['Bash']);
    assert.equal(c.max_delegations, 2);
  });

  test('getContract retrieves by agent_id', () => {
    const found = getContract('test-agent-1');
    assert.ok(found);
    assert.equal(found.agent_id, 'test-agent-1');
  });

  test('listContracts includes created contracts', () => {
    const all = listContracts();
    assert.ok(all.some(c => c.agent_id === 'test-agent-1'));
  });
});

describe('validateAction', () => {
  test('allows permitted tool + permitted file', () => {
    const r = validateAction('test-agent-1', 'Read', 'src/utils.js');
    assert.equal(r.allowed, true);
  });

  test('blocks forbidden tool', () => {
    const r = validateAction('test-agent-1', 'Bash', undefined);
    assert.equal(r.allowed, false);
    assert.ok(r.reason.toLowerCase().includes('forbidden'));
  });

  test('blocks file outside allowed paths', () => {
    const r = validateAction('test-agent-1', 'Read', '/etc/passwd');
    assert.equal(r.allowed, false);
  });

  test('blocks unknown agent with no contract', () => {
    const r = validateAction('no-such-agent', 'Read', undefined);
    assert.equal(r.allowed, false);
  });

  test('blocks tool not in allowed list', () => {
    const r = validateAction('test-agent-1', 'Write', undefined);
    assert.equal(r.allowed, false);
  });
});

describe('detectDelegationLoop', () => {
  test('detects circular A->B->C->A', () => {
    const r = detectDelegationLoop([
      { from: 'A', to: 'B', task: 'x' },
      { from: 'B', to: 'C', task: 'y' },
      { from: 'C', to: 'A', task: 'z' },
    ]);
    assert.equal(r.is_loop, true);
    assert.ok(r.cycle.includes('A'));
  });

  test('no loop in linear chain', () => {
    const r = detectDelegationLoop([
      { from: 'A', to: 'B', task: 'x' },
      { from: 'B', to: 'C', task: 'y' },
    ]);
    assert.equal(r.is_loop, false);
  });

  test('empty chain is not a loop', () => {
    const r = detectDelegationLoop([]);
    assert.equal(r.is_loop, false);
  });
});

describe('logAction and getComplianceReport', () => {
  test('logs action and increments count', () => {
    const r = logAction('test-agent-1', 'tool_call', { tool_name: 'Read' });
    assert.equal(r.logged, true);
    assert.ok(r.total_actions >= 1);
  });

  test('compliance report includes test-agent-1', () => {
    const report = getComplianceReport();
    assert.ok(report.total_agents >= 1);
    const a = report.agents.find(x => x.agent_id === 'test-agent-1');
    assert.ok(a);
    assert.ok(a.total_actions >= 1);
  });
});
