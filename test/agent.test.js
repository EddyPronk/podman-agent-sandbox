import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentArgs, agentOf } from '../dist/agent.js';

/** A config folder with a Feature folder for each of AGENTS in .devcontainer/agent; EXTRA: other folders there. */
function folder(agents, extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
    mkdirSync(join(dir, '.devcontainer'));
    for (const name of agents) {
        mkdirSync(join(dir, '.devcontainer', 'agent', name), { recursive: true });
        writeFileSync(join(dir, '.devcontainer', 'agent', name, 'devcontainer-feature.json'), `{"id": "${name}"}\n`);
    }
    for (const name of extra) mkdirSync(join(dir, '.devcontainer', 'agent', name), { recursive: true });
    return dir;
}

test('agentArgs: the agent Feature folder, named for --additional-features from inside .devcontainer', () => {
    assert.deepEqual(agentArgs(folder(['codex'])), ['--additional-features', '{"./agent/codex":{}}']);
    assert.equal(agentOf(folder(['claude-code'])), 'claude-code');
});

test('agentArgs: no agent folder, or one without a Feature in it: nothing added', () => {
    assert.deepEqual(agentArgs(folder([])), []);
    assert.deepEqual(agentArgs(folder([], ['empty'])), []);
});

test('agentOf: two agents are refused', () => {
    assert.throws(() => agentOf(folder(['codex', 'claude-code'])), /has more than one agent \(claude-code, codex\): a sandbox has one/);
});
