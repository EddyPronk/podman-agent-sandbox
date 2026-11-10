import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The extra Features recorded for sandbox NAME in DIR, and its agent folder's name (or null). */
function made(dir, name) {
    const conf = join(dir, name, '.devcontainer');
    const file = join(conf, 'sandbox-features.json');
    return {
        features: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
        agent: existsSync(join(conf, 'agent')) ? readdirSync(join(conf, 'agent')) : null,
    };
}

test('new: an open-network template gets its default agent, claude-code, with trustWorkspace from the template option', () => {
    const plain = sandbox('new', 'c', '--template', 'open-network');
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^with agent claude-code \(in \.devcontainer\/agent\/claude-code\)$/m);
    assert.deepEqual(made(plain.dir, 'c'), { features: { './agent/claude-code': { trustWorkspace: true } }, agent: ['claude-code'] });
    assert.equal(featureArgs(join(plain.dir, 'c'))[1], '{"./agent/claude-code":{"trustWorkspace":true}}');

    const off = sandbox('new', 'c', '--template', 'proxy-client', '--option', 'trustWorkspace=0');
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(made(off.dir, 'c').features, { './agent/claude-code': { trustWorkspace: false } });
});

test('new --agent: another agent, or none; offline has none by default; an unknown one is refused', () => {
    const codex = sandbox('new', 'x', '--template', 'open-network', '--agent', 'codex', '--feature', AWS);
    assert.equal(codex.status, 0, codex.stderr);
    assert.deepEqual(made(codex.dir, 'x'), { features: { [AWS]: {}, './agent/codex': { trustWorkspace: true } }, agent: ['codex'] });

    const none = sandbox('new', 'x', '--template', 'open-network', '--agent', 'none');
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(made(none.dir, 'x'), { features: null, agent: null });
    assert.doesNotMatch(none.stdout, /with agent/);

    const offline = sandbox('new', 'x', '--template', 'offline');
    assert.deepEqual(made(offline.dir, 'x'), { features: null, agent: null });

    const nope = sandbox('new', 'x', '--template', 'open-network', '--agent', 'nope');
    assert.equal(nope.status, 1);
    assert.match(nope.stderr, /--agent nope: no such agent; the agents are claude-code, codex, or none/);
    assert.equal(readdirSync(nope.dir).length, 0, 'nothing made');
});

test('extraFeatures: a recorded agent whose folder was swapped for another is left out', () => {
    const dir = folder(['codex']);
    writeFeatures(dir, { './agent/claude-code': { trustWorkspace: false }, [AWS]: {} });
    assert.deepEqual(JSON.parse(featureArgs(dir)[1]), { [AWS]: {}, './agent/codex': {} });
});

test('new --inplace --template: the agent goes into the project\'s own devcontainer.json; plain --inplace refuses --agent', () => {
    const project = mkdtempSync(join(tmpdir(), 'features-project-'));
    const result = sandbox('new', 'p', '--workspace', project, '--inplace', '--template', 'open-network');
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(project, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.deepEqual(config.features['./agent/claude-code'], { trustWorkspace: true });
    assert.ok(existsSync(join(project, '.devcontainer', 'agent', 'claude-code', 'install.sh')));
    assert.deepEqual(featureArgs(join(result.dir, 'p')), [], 'the sandbox goes by the project\'s config');

    const plain = sandbox('new', 'q', '--workspace', project, '--inplace', '--agent', 'codex');
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /--agent with --inplace needs --template/);
});

/**
 * A copy of bundled template NAME in a temp folder, as a template given by path: EDIT(text) changes
 * its devcontainer.json's text; AGENTS (names from agents/) are put in its .devcontainer/agent.
 */
function templateCopy(name, { edit = (text) => text, agents = [] } = {}) {
    const dir = join(mkdtempSync(join(tmpdir(), 'features-template-')), name);
    cpSync(fileURLToPath(new URL(`../templates/${name}`, import.meta.url)), dir, { recursive: true });
    const file = join(dir, '.devcontainer', 'devcontainer.json');
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
    for (const agent of agents) {
        cpSync(fileURLToPath(new URL(`../agents/${agent}`, import.meta.url)), join(dir, '.devcontainer', 'agent', agent), { recursive: true });
    }
    return dir;
}
const withComment = (text) => text.replace('{\n', '{\n  // a comment: JSONC, as the Dev Containers CLI allows\n');
const withoutAgent = (text) => text.replace('      "agent": "claude-code",\n', '');

test('new: a template with comments (JSONC) works; its default agent can\'t be read, so it needs --agent', () => {
    const plain = sandbox('new', 'x', '--template', templateCopy('open-network', { edit: (t) => withComment(withoutAgent(t)) }));
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(made(plain.dir, 'x'), { features: null, agent: null });

    const marked = sandbox('new', 'x', '--template', templateCopy('open-network', { edit: withComment }));
    assert.equal(marked.status, 1);
    assert.match(marked.stderr, /has comments or trailing commas, so sandbox can't read its default agent: give --agent NAME \(or --agent none\)/);

    const given = sandbox('new', 'x', '--template', templateCopy('open-network', { edit: withComment }), '--agent', 'codex');
    assert.equal(given.status, 0, given.stderr);
    assert.deepEqual(made(given.dir, 'x').agent, ['codex']);
});

test('new: a template\'s own agent folder gives way when sandbox decides the agent, and stays when it doesn\'t', () => {
    const own = () => templateCopy('offline', { agents: ['claude-code'] });
    const none = sandbox('new', 'x', '--template', own(), '--agent', 'none');
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(made(none.dir, 'x').agent, null, '--agent none: no agent');

    const codex = sandbox('new', 'x', '--template', own(), '--agent', 'codex');
    assert.equal(codex.status, 0, codex.stderr);
    assert.deepEqual(made(codex.dir, 'x').agent, ['codex'], '--agent codex: only codex');
    assert.equal(featureArgs(join(codex.dir, 'x'))[1], '{"./agent/codex":{}}');

    const kept = sandbox('new', 'x', '--template', own());
    assert.equal(kept.status, 0, kept.stderr);
    assert.deepEqual(made(kept.dir, 'x').agent, ['claude-code'], 'no --agent, no default: the template\'s own');

    const marked = sandbox('new', 'x', '--template', templateCopy('open-network', { agents: ['codex'] }));
    assert.equal(marked.status, 0, marked.stderr);
    assert.deepEqual(made(marked.dir, 'x').agent, ['claude-code'], 'the template\'s default replaces a folder it ships too');
});

test('codex trust-workspace: the path is escaped as a TOML string, written once; a newline is refused', () => {
    const home = mkdtempSync(join(tmpdir(), 'features-codex-'));
    const script = fileURLToPath(new URL('../agents/codex/trust-workspace', import.meta.url));
    const run = (dir) => spawnSync('sh', [script, dir], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const config = () => readFileSync(join(home, '.codex', 'config.toml'), 'utf8');

    assert.equal(run('/w/a"b\\c').status, 0);
    assert.match(config(), /^\[projects\."\/w\/a\\"b\\\\c"\]\ntrust_level = "trusted"$/m);
    assert.equal(run('/w/a"b\\c').status, 0);
    assert.equal(config().split('[projects.').length - 1, 1, 'the table once');
    assert.equal(run('/workspace').status, 0);
    assert.match(config(), /^\[projects\."\/workspace"\]$/m);

    assert.equal(run('/w/a\nb').status, 2, 'a newline: refused');
});

/** A policy folder with Claude Code's managed policy files, as --agent-policy takes it. */
function policyDir() {
    const dir = mkdtempSync(join(tmpdir(), 'features-policy-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# inside\n');
    writeFileSync(join(dir, 'managed-settings.json'), '{"permissions": {"deny": ["Bash(gh:*)"]}}\n');
    return dir;
}

test('claude-code agent: its policy folder is mounted read-only at /etc/claude-code, from the agent folder', () => {
    const meta = JSON.parse(readFileSync(fileURLToPath(new URL('../agents/claude-code/devcontainer-feature.json', import.meta.url)), 'utf8'));
    assert.deepEqual(meta.mounts,
        ['type=bind,source=${localWorkspaceFolder}/.devcontainer/agent/claude-code/policy,target=/etc/claude-code,readonly']);
    assert.ok(existsSync(fileURLToPath(new URL('../agents/claude-code/policy', import.meta.url))), 'the folder ships, so the mount has a source');
});

test('new --agent-policy DIR: the files go into the agent\'s policy folder; without it, the folder has only its README', () => {
    const policy = sandbox('new', 'c', '--template', 'nested-containers', '--agent-policy', policyDir());
    assert.equal(policy.status, 0, policy.stderr);
    const folder = join(policy.dir, 'c', '.devcontainer', 'agent', 'claude-code', 'policy');
    assert.deepEqual(readdirSync(folder).sort(), ['CLAUDE.md', 'README.md', 'managed-settings.json']);
    assert.equal(readFileSync(join(folder, 'CLAUDE.md'), 'utf8'), '# inside\n');
    assert.match(policy.stdout, /^with managed policy CLAUDE\.md, managed-settings\.json \(in \.devcontainer\/agent\/claude-code\/policy\)$/m);

    const plain = sandbox('new', 'c', '--template', 'open-network');
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(readdirSync(join(plain.dir, 'c', '.devcontainer', 'agent', 'claude-code', 'policy')), ['README.md']);
    assert.doesNotMatch(plain.stdout, /managed policy/);
});

test('new --agent-policy: refused without an agent that has one, for a missing folder, and with --inplace; nothing made', () => {
    const cases = [
        [['--template', 'open-network', '--agent', 'none'], /--agent-policy needs an agent/],
        [['--template', 'offline'], /--agent-policy needs an agent/],
        [['--template', 'open-network', '--agent', 'codex'], /--agent-policy: agent codex has no managed policy/],
        [['--template', 'open-network', '--policy-missing'], /--agent-policy .*: no such folder/],
    ];
    for (const [args, message] of cases) {
        const missing = args.includes('--policy-missing');
        const result = sandbox('new', 'x', ...args.filter((a) => a !== '--policy-missing'),
            '--agent-policy', missing ? join(tmpdir(), 'no-such-policy-folder') : policyDir());
        assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
        assert.match(result.stderr, message);
        assert.equal(readdirSync(result.dir).length, 0, `${args.join(' ')}: nothing made`);
    }
    const inplace = sandbox('new', 'x', '--workspace', tmpdir(), '--inplace', '--agent-policy', policyDir());
    assert.equal(inplace.status, 1);
    assert.match(inplace.stderr, /--agent-policy can't go with --inplace yet/);
});
