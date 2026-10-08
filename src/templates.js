// Dev Container Templates bundled with sandbox, applied the way the spec describes:
// copy the template folder and replace ${templateOption:KEY} with the chosen values.
// https://containers.dev/implementors/templates/
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxError } from './devcontainer.js';
import { writeSeccompProfile } from './seccomp.js';

export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
const METADATA = 'devcontainer-template.json';

/** Metadata of every template under ROOT, sorted by id. */
export function listTemplates(root = TEMPLATES_DIR) {
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, METADATA)))
        .map((entry) => JSON.parse(readFileSync(join(root, entry.name, METADATA), 'utf8')))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** ['KEY=VALUE', ...] → { KEY: 'VALUE', ... } */
export function parseOptionArgs(args) {
    const options = {};
    for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq < 1) throw new SandboxError(`invalid option '${arg}' (expected KEY=VALUE)`);
        options[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    return options;
}

/** Check GIVEN against the template's options and fill in defaults. All values are strings. */
export function resolveOptions(template, given) {
    const declared = template.options ?? {};
    for (const key of Object.keys(given)) {
        if (!Object.hasOwn(declared, key)) {
            throw new SandboxError(`template '${template.id}' has no option '${key}'`);
        }
    }
    const values = {};
    for (const [key, opt] of Object.entries(declared)) {
        const value = Object.hasOwn(given, key) ? given[key] : String(opt.default ?? '');
        if (opt.type === 'boolean' && value !== 'true' && value !== 'false') {
            throw new SandboxError(`option '${key}' must be true or false, not '${value}'`);
        }
        if (opt.enum && !opt.enum.includes(value)) {
            throw new SandboxError(`option '${key}' must be one of ${opt.enum.join(', ')}, not '${value}'`);
        }
        values[key] = value;
    }
    return values;
}

/** Replace ${templateOption:KEY} in TEXT; unknown keys are left as they are. */
export function substitute(text, values) {
    return text.replace(/\$\{templateOption:([^}]+)\}/g,
        (match, key) => (Object.hasOwn(values, key) ? values[key] : match));
}

/**
 * SPEC is a bundled template's id, or a path to a template folder (anything with a '/').
 * Returns the template's metadata and its folder.
 */
export function findTemplate(spec, root = TEMPLATES_DIR) {
    if (spec.includes('/')) {
        const src = resolve(spec);
        if (!existsSync(join(src, METADATA))) {
            throw new SandboxError(`no template at ${src} (it has no ${METADATA})`);
        }
        return { template: JSON.parse(readFileSync(join(src, METADATA), 'utf8')), src };
    }
    const template = listTemplates(root).find((t) => t.id === spec);
    if (!template) {
        const ids = listTemplates(root).map((t) => t.id).join(', ');
        throw new SandboxError(`no template '${spec}' (available: ${ids}; or give a path to a template folder)`);
    }
    return { template, src: join(root, spec) };
}

/**
 * Create DEST from template SPEC (see findTemplate). DEST must not exist yet. A template whose
 * metadata has "x-sandbox": { "seccompAllow": [...] } also gets its seccomp profile (seccomp.js);
 * HOOKS are passed on to it (tests).
 */
export function applyTemplate(spec, dest, given = {}, root = TEMPLATES_DIR, hooks = {}) {
    const { template, src } = findTemplate(spec, root);
    if (existsSync(dest)) throw new SandboxError(`${dest} already exists`);
    const values = resolveOptions(template, given);
    cpSync(src, dest, { recursive: true, filter: (path) => path !== join(src, METADATA) });
    for (const file of readdirSync(dest, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const path = join(file.parentPath, file.name);
        const text = readFileSync(path, 'utf8');
        const replaced = substitute(text, values);
        if (replaced !== text) writeFileSync(path, replaced);
    }
    const allow = template['x-sandbox']?.seccompAllow;
    if (allow?.length) {
        try {
            writeSeccompProfile(dest, allow, hooks);
        } catch (err) {
            rmSync(dest, { recursive: true, force: true });
            throw err;
        }
    }
    return dest;
}
