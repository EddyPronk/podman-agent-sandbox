// Dev Container Templates bundled with sandbox, applied the way the spec describes:
// copy the template folder and replace ${templateOption:KEY} with the chosen values.
// https://containers.dev/implementors/templates/
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION, SandboxError } from './devcontainer.js';
import { isBoolean, isObject, isString, isStringList, optional } from './json.js';
import type { JsonObject } from './json.js';
import { writeSeccompProfile } from './seccomp.js';
import type { SeccompOptions } from './seccomp.js';

export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
const METADATA = 'devcontainer-template.json';

/** Our namespace in devcontainer.json's "customizations": marks a config written for sandbox. */
export const MARKER = 'podman-agent-sandbox';

/** A template's devcontainer-template.json, as far as readMetadata checks it. */
export interface Template {
    id: string;
    description?: string;
    options?: { [key: string]: TemplateOption };
    [field: string]: unknown;
}

export interface TemplateOption {
    type?: string;
    description?: string;
    proposals?: string[];
    enum?: string[];
    default?: string | boolean;
}

/** Template option values by key: from --option, and as a template is applied with them. */
export type OptionValues = { [key: string]: string };

/** CONFIG's (parsed devcontainer.json) "customizations": { MARKER: {...} }, if it has one. */
export function markerOf(config: unknown): JsonObject | undefined {
    const customizations = isObject(config) ? config.customizations : undefined;
    const marker = isObject(customizations) ? customizations[MARKER] : undefined;
    return isObject(marker) ? marker : undefined;
}

/** Is version HAVE (X.Y.Z) at least NEED? A prerelease or build suffix is ignored. */
export function versionAtLeast(have: string, need: string): boolean {
    const parts = (v: string) => v.split(/[-+]/)[0].split('.').map(Number);
    const [a, b] = [parts(have), parts(need)];
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return true;
}

/**
 * Refuse CONFIG (from FILE) when its marker's "minVersion" is newer than this sandbox (VERSION): it
 * relies on something an older sandbox would silently do without (a seccomp allowance, a check).
 * Releases before 0.8.0 ignore the field.
 */
export function checkMinVersion(config: unknown, file: string, version: string = PACKAGE_VERSION): void {
    const min = markerOf(config)?.minVersion;
    if (min === undefined) return;
    if (typeof min !== 'string' || !/^\d+\.\d+\.\d+$/.test(min)) {
        throw new SandboxError(`${file}: "${MARKER}".minVersion must be a version like "0.8.0", not ${JSON.stringify(min)}`);
    }
    if (!versionAtLeast(version, min)) {
        throw new SandboxError(`${file} needs sandbox ${min} or later, and this is ${version}: update sandbox `
            + '(run the install one-liner from the README again)');
    }
}

/** Metadata of every template under ROOT, sorted by id. */
export function listTemplates(root: string = TEMPLATES_DIR): Template[] {
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, METADATA)))
        .map((entry) => readMetadata(join(root, entry.name, METADATA)))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** A template's METADATA file, with what sandbox reads from it checked. */
function readMetadata(file: string): Template {
    const template: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isTemplate(template)) {
        throw new SandboxError(`${file} isn't a template's metadata: it needs an "id", and "options" (if there) `
            + 'as https://containers.dev/implementors/templates/ describes them');
    }
    return template;
}

function isOption(value: unknown): value is TemplateOption {
    return isObject(value) && optional(value.type, isString) && optional(value.description, isString)
        && optional(value.proposals, isStringList) && optional(value.enum, isStringList)
        && optional(value.default, (d) => isString(d) || isBoolean(d));
}

function isTemplate(value: unknown): value is Template {
    return isObject(value) && isString(value.id) && optional(value.description, isString)
        && optional(value.options, (options) => isObject(options) && Object.values(options).every(isOption));
}

/** ['KEY=VALUE', ...] → { KEY: 'VALUE', ... } */
export function parseOptionArgs(args: string[]): OptionValues {
    const options: OptionValues = {};
    for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq < 1) throw new SandboxError(`invalid option '${arg}' (expected KEY=VALUE)`);
        options[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    return options;
}

/** Check GIVEN against the template's options and fill in defaults. All values are strings. */
export function resolveOptions(template: Template, given: OptionValues): OptionValues {
    const declared = template.options ?? {};
    for (const key of Object.keys(given)) {
        if (!Object.hasOwn(declared, key)) {
            if (key === 'image') {
                const ids = listTemplates().filter((t) => t.options?.image).map((t) => t.id);
                const able = ids.length > 1 ? `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}` : ids.join('');
                throw new SandboxError(`template '${template.id}' has no image option; --image works with ${able}`);
            }
            throw new SandboxError(`template '${template.id}' has no option '${key}'`);
        }
    }
    const values: OptionValues = {};
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

/** --image IMAGE is the template option image; GIVEN (from --option) may name it too, but the same. */
export function withImage(given: OptionValues, image: string | undefined): OptionValues {
    if (image === undefined) return given;
    if (Object.hasOwn(given, 'image') && fullImageName(given.image) !== fullImageName(image)) {
        throw new SandboxError(`--image ${image} and --option image=${given.image} disagree`);
    }
    return { ...given, image };
}

// Base images tested with --image (besides each template's default). Others may work, but they are
// experimental: sandbox new warns.
export const TESTED_IMAGES = ['docker.io/library/ubuntu:26.04'];

/**
 * True for an --image that is neither the template's default (if it has one) nor tested; Docker Hub
 * short names count as the full name.
 */
export function experimentalImage(image: string, defaultImage: string | undefined): boolean {
    if (defaultImage !== undefined && fullImageName(image) === fullImageName(defaultImage)) return false;
    return !TESTED_IMAGES.includes(fullImageName(image));
}

/** ubuntu:26.04 and docker.io/ubuntu:26.04 → docker.io/library/ubuntu:26.04; other registries as they are. */
function fullImageName(ref: string): string {
    const first = ref.split('/')[0];
    const registry = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
    if (registry && first !== 'docker.io') return ref;
    const path = registry ? ref.slice(first.length + 1) : ref;
    return `docker.io/${path.includes('/') ? path : `library/${path}`}`;
}

/** Replace ${templateOption:KEY} in TEXT; unknown keys are left as they are. */
export function substitute(text: string, values: OptionValues): string {
    return text.replace(/\$\{templateOption:([^}]+)\}/g,
        (match, key: string) => (Object.hasOwn(values, key) ? values[key] : match));
}

/**
 * SPEC is a bundled template's id, or a path to a template folder (anything with a '/').
 * Returns the template's metadata and its folder.
 */
export function findTemplate(spec: string, root: string = TEMPLATES_DIR): { template: Template; src: string } {
    if (spec.includes('/')) {
        const src = resolve(spec);
        if (!existsSync(join(src, METADATA))) {
            throw new SandboxError(`no template at ${src} (it has no ${METADATA})`);
        }
        return { template: readMetadata(join(src, METADATA)), src };
    }
    const template = listTemplates(root).find((t) => t.id === spec);
    if (!template) {
        const ids = listTemplates(root).map((t) => t.id).join(', ');
        throw new SandboxError(`no template '${spec}' (available: ${ids}; or give a path to a template folder)`);
    }
    return { template, src: join(root, spec) };
}

/**
 * The system calls DIR's config adds to the seccomp profile: its devcontainer.json's
 * "customizations": { "podman-agent-sandbox": { "seccompAllow": [...] } }, or else (older templates
 * given by path) TEMPLATE metadata's "x-sandbox": { "seccompAllow": [...] }.
 */
export function seccompAllow(dir: string, template: JsonObject = {}): string[] | undefined {
    const file = join(dir, '.devcontainer', 'devcontainer.json');
    let config: unknown = {};
    try {
        config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        // no config, or JSONC: only the metadata can say
    }
    const legacy = isObject(template['x-sandbox']) ? template['x-sandbox'].seccompAllow : undefined;
    const allow = markerOf(config)?.seccompAllow ?? legacy;
    if (allow !== undefined && !isStringList(allow)) {
        throw new SandboxError(`${dir}: seccompAllow must be a list of system call names, not ${JSON.stringify(allow)}`);
    }
    return allow;
}

/**
 * Create DEST from template SPEC (see findTemplate). DEST must not exist yet. A template whose
 * config has seccompAllow (above) also gets its seccomp profile (seccomp.js), unless HOOKS.seccomp is
 * false (--inplace makes it later); HOOKS are passed on to it (tests). Returns the template's metadata.
 */
export function applyTemplate(
    spec: string,
    dest: string,
    given: OptionValues = {},
    root: string = TEMPLATES_DIR,
    hooks: SeccompOptions & { seccomp?: boolean } = {},
): Template {
    const { template, src } = findTemplate(spec, root);
    if (existsSync(dest)) throw new SandboxError(`${dest} already exists`);
    const values = resolveOptions(template, given);
    const config = join(src, '.devcontainer', 'devcontainer.json');
    if (existsSync(config)) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(readFileSync(config, 'utf8'));
        } catch {
            // not plain JSON: readConfig says so later, where it matters
        }
        checkMinVersion(parsed, config);
    }
    cpSync(src, dest, { recursive: true, filter: (path) => path !== join(src, METADATA) });
    for (const file of readdirSync(dest, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const path = join(file.parentPath, file.name);
        const text = readFileSync(path, 'utf8');
        const replaced = substitute(text, values);
        if (replaced !== text) writeFileSync(path, replaced);
    }
    try {
        const allow = seccompAllow(dest, template);
        if (allow?.length && hooks.seccomp !== false) writeSeccompProfile(dest, allow, hooks);
    } catch (err) {
        rmSync(dest, { recursive: true, force: true });
        throw err;
    }
    return template;
}
