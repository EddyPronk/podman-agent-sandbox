import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentOf, featureArgs, parseFeatureArgs, recordedFeatures, writeFeatures } from '../dist/features.js';

const SANDBOX = fileURLToPath(new URL('../bin/sandbox.js', import.meta.url));
const AWS = 'ghcr.io/devcontainers/features/aws-cli:1';

/** A config folder with a Feature folder for each of AGENTS in .devcontainer/agent; EXTRA: other folders there. */
function folder(agents = [], extra = []) {
    const dir = mkdtempSync(join(tmpdir(), 'features-test-'));
    mkdirSync(join(dir, '.devcontainer'));
    for (const name of agents) {
        mkdirSync(join(dir, '.devcontainer', 'agent', name), { recursive: true });
        writeFileSync(join(dir, '.devcontainer', 'agent', name, 'devcontainer-feature.json'), `{"id": "${name}"}\n`);
    }
    for (const name of extra) mkdirSync(join(dir, '.devcontainer', 'agent', name), { recursive: true });
    return dir;
}

test('featureArgs: the agent Feature folder, named for --additional-features from inside .devcontainer', () => {
    assert.deepEqual(featureArgs(folder(['codex'])), ['--additional-features', '{"./agent/codex":{}}']);
    assert.equal(agentOf(folder(['claude-code'])), 'claude-code');
});

test('featureArgs: nothing to add, nothing added (no agent, or an agent folder without a Feature)', () => {
    assert.deepEqual(featureArgs(folder()), []);
    assert.deepEqual(featureArgs(folder([], ['empty'])), []);
});

test('agentOf: two agents are refused', () => {
    assert.throws(() => agentOf(folder(['codex', 'claude-code'])), /has more than one agent \(claude-code, codex\): a sandbox has one/);
});

test('featureArgs: the recorded --feature Features and the agent, in one --additional-features', () => {
    const dir = folder(['codex']);
    writeFeatures(dir, { [AWS]: {}, 'ghcr.io/devcontainers/features/python:1': { version: '3.13' } });
    const [flag, json] = featureArgs(dir);
    assert.equal(flag, '--additional-features');
    assert.deepEqual(JSON.parse(json), { [AWS]: {}, 'ghcr.io/devcontainers/features/python:1': { version: '3.13' }, './agent/codex': {} });
});

test('featureArgs: nothing for an --inplace sandbox, whose agent folder and sandbox-features.json would be the project\'s', () => {
    const dir = folder(['codex']);
    writeFeatures(dir, { [AWS]: {} });
    writeFileSync(join(dir, 'sandbox.json'), JSON.stringify({ workspace: '/p', inplace: true, configTree: 'x' }));
    assert.deepEqual(featureArgs(dir), []);
    writeFileSync(join(dir, 'sandbox.json'), JSON.stringify({ workspace: '/p' }));
    assert.equal(featureArgs(dir).length, 2, 'a --workspace sandbox without --inplace keeps them');
});

test('recordedFeatures: a file sandbox new didn\'t write is refused', () => {
    const dir = folder();
    writeFileSync(join(dir, '.devcontainer', 'sandbox-features.json'), '["ghcr.io/x:1"]\n');
    assert.throws(() => recordedFeatures(dir), /isn't what sandbox new writes/);
});

test('parseFeatureArgs: REF, or REF=JSON options; local paths and bad options are refused', () => {
    assert.deepEqual(parseFeatureArgs([AWS, 'ghcr.io/devcontainers/features/python:1={"version": "3.13"}']),
        { [AWS]: {}, 'ghcr.io/devcontainers/features/python:1': { version: '3.13' } });
    assert.deepEqual(parseFeatureArgs([]), {});
    assert.throws(() => parseFeatureArgs(['./codex']), /give a published Feature's reference/);
    assert.throws(() => parseFeatureArgs(['/abs/codex']), /give a published Feature's reference/);
    assert.throws(() => parseFeatureArgs([`${AWS}={version}`]), /the options after = must be JSON/);
    assert.throws(() => parseFeatureArgs([`${AWS}=[1]`]), /must be a JSON object/);
    assert.throws(() => parseFeatureArgs(['={}']), /no Feature reference/);
});

/** sandbox ARGS in a fresh $SANDBOX_DIR (no podman needed for new): { status, stdout, stderr, dir }. */
function sandbox(...args) {
    const dir = mkdtempSync(join(tmpdir(), 'features-new-'));
    const result = spawnSync(process.execPath, [SANDBOX, ...args], { encoding: 'utf8', env: { ...process.env, SANDBOX_DIR: dir } });
    return { ...result, dir };
}

test('new --feature: recorded next to the config; devcontainer.json is the template\'s', () => {
    const result = sandbox('new', 'aws', '--template', 'offline', '--feature', AWS);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^with Feature ${AWS.replace(/[.]/g, '\\.')} \\(in \\.devcontainer/sandbox-features\\.json\\)$`, 'm'));
    const conf = join(result.dir, 'aws', '.devcontainer');
    assert.deepEqual(JSON.parse(readFileSync(join(conf, 'sandbox-features.json'), 'utf8')), { [AWS]: {} });
    assert.doesNotMatch(readFileSync(join(conf, 'devcontainer.json'), 'utf8'), /aws-cli/);
});

test('new --feature: bad values and --inplace are refused before anything is made', () => {
    const local = sandbox('new', 'x', '--template', 'offline', '--feature', './codex');
    assert.equal(local.status, 1);
    assert.match(local.stderr, /give a published Feature's reference/);
    assert.equal(spawnSync('ls', [local.dir], { encoding: 'utf8' }).stdout, '', 'nothing made');
    const inplace = sandbox('new', 'x', '--workspace', tmpdir(), '--inplace', '--feature', AWS);
    assert.equal(inplace.status, 1);
    assert.match(inplace.stderr, /--feature can't go with --inplace yet/);
});
