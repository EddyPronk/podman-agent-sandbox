import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SandboxError } from '../src/devcontainer.js';
import { applyTemplate, listTemplates, parseOptionArgs, resolveOptions, substitute } from '../src/templates.js';

/** A template root with one template "demo" that has a network option. */
function demoRoot() {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    const dir = join(root, 'demo');
    mkdirSync(join(dir, '.devcontainer'), { recursive: true });
    writeFileSync(join(dir, 'devcontainer-template.json'), JSON.stringify({
        id: 'demo',
        options: {
            network: { type: 'string', enum: ['offline', 'internet'], default: 'offline' },
            debug: { type: 'boolean', default: false },
        },
    }));
    writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'),
        '{"name": "${localWorkspaceFolderBasename}", "net": "${templateOption:network}", "x": "${templateOption:nope}"}');
    return root;
}

test('bundled templates include claude with its dot-folder', () => {
    const ids = listTemplates().map((t) => t.id);
    assert.ok(ids.includes('claude'));
});

test('applyTemplate copies, substitutes and drops the metadata file', () => {
    const root = demoRoot();
    const dest = join(root, 'out', 'box');
    applyTemplate('demo', dest, { network: 'internet' }, root);
    const config = readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8');
    assert.match(config, /"net": "internet"/);
    assert.match(config, /\$\{localWorkspaceFolderBasename\}/, 'other variables are left for the CLI');
    assert.match(config, /\$\{templateOption:nope\}/, 'unknown options are left as they are');
    assert.ok(!existsSync(join(dest, 'devcontainer-template.json')));
});

test('applyTemplate uses defaults', () => {
    const root = demoRoot();
    const dest = join(root, 'box');
    applyTemplate('demo', dest, {}, root);
    assert.match(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'), /"net": "offline"/);
});

test('applyTemplate refuses an existing folder and unknown ids', () => {
    const root = demoRoot();
    assert.throws(() => applyTemplate('demo', root, {}, root), /already exists/);
    assert.throws(() => applyTemplate('nope', join(root, 'a'), {}, root), /no template 'nope'/);
});

test('a path applies a template folder outside the bundled ones', () => {
    const root = demoRoot();
    const dest = join(root, 'from-path');
    // Bundled root is somewhere else entirely: the path alone finds the template.
    applyTemplate(join(root, 'demo'), dest, { network: 'internet' }, mkdtempSync(join(tmpdir(), 'empty-')));
    assert.match(readFileSync(join(dest, '.devcontainer', 'devcontainer.json'), 'utf8'), /"net": "internet"/);
    assert.ok(!existsSync(join(dest, 'devcontainer-template.json')));
});

test('a path without template metadata is refused', () => {
    const root = demoRoot();
    assert.throws(() => applyTemplate(join(root, 'demo', '.devcontainer'), join(root, 'x'), {}, root),
        /no template at .* \(it has no devcontainer-template.json\)/);
});

test('a bare id never leaves the bundled templates', () => {
    const root = demoRoot();
    // 'demo' exists one level up from this root; without a '/' it is looked up as an id only.
    assert.throws(() => applyTemplate('..', join(root, 'y'), {}, join(root, 'demo')), SandboxError);
});

test('resolveOptions checks names, enums and booleans', () => {
    const template = JSON.parse(readFileSync(join(demoRoot(), 'demo', 'devcontainer-template.json'), 'utf8'));
    assert.deepEqual(resolveOptions(template, {}), { network: 'offline', debug: 'false' });
    assert.throws(() => resolveOptions(template, { colour: 'red' }), /no option 'colour'/);
    assert.throws(() => resolveOptions(template, { network: 'proxy' }), /must be one of/);
    assert.throws(() => resolveOptions(template, { debug: 'yes' }), /true or false/);
});

test('parseOptionArgs splits on the first =', () => {
    assert.deepEqual(parseOptionArgs(['a=1', 'b=x=y', 'c=']), { a: '1', b: 'x=y', c: '' });
    assert.throws(() => parseOptionArgs(['novalue']), /KEY=VALUE/);
    assert.throws(() => parseOptionArgs(['=1']), /KEY=VALUE/);
});

test('substitute replaces every occurrence', () => {
    assert.equal(substitute('${templateOption:a}-${templateOption:a}', { a: 'x' }), 'x-x');
});
