// Features a sandbox gets next to its config rather than in it (lab 47): the agent, a local Feature in
// .devcontainer/agent/NAME/, and published Features given to sandbox new with --feature, recorded in
// .devcontainer/sandbox-features.json. Every devcontainer command that builds or reads the config gets
// them with --additional-features, so devcontainer.json stays as the template (or the user) wrote it.
// The files are the record: .devcontainer is read-only inside the sandbox, so what runs there can't
// change what the next build runs as root. The Dev Containers CLI takes a local Feature only from
// inside .devcontainer (not by absolute path), and a published one by its OCI reference.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxError } from './devcontainer.js';
import { isObject } from './json.js';
import type { JsonObject } from './json.js';
import { markerOf } from './templates.js';
import type { OptionValues } from './templates.js';
import { readSettings } from './workspace.js';

/** Where the agent's Feature folder goes, inside .devcontainer. */
export const AGENT_DIR = 'agent';
/** The --feature Features, inside .devcontainer: { REF: options }, as in devcontainer.json's "features". */
export const FEATURES_FILE = 'sandbox-features.json';

/**
 * The agent Feature of the sandbox in config folder DIR: its folder's name (e.g. codex), or null when
 * it has none. More than one is refused: a sandbox has one agent.
 */
export function agentOf(dir: string): string | null {
    const root = join(dir, '.devcontainer', AGENT_DIR);
    if (!existsSync(root)) return null;
    const agents = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'devcontainer-feature.json')))
        .map((e) => e.name).sort();
    if (agents.length > 1) {
        throw new SandboxError(`${root} has more than one agent (${agents.join(', ')}): a sandbox has one; `
            + 'remove the others');
    }
    return agents[0] ?? null;
}

/** The --feature Features recorded in DIR: {} without the file. */
export function recordedFeatures(dir: string): JsonObject {
    const file = join(dir, '.devcontainer', FEATURES_FILE);
    if (!existsSync(file)) return {};
    const features: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObject(features) || !Object.values(features).every(isObject)) {
        throw new SandboxError(`${file} isn't what sandbox new writes: { "REFERENCE": { options }, ... }`);
    }
    return features;
}

/** Record FEATURES ({ REF: options }) in config folder DIR. */
export function writeFeatures(dir: string, features: JsonObject): void {
    writeFileSync(join(dir, '.devcontainer', FEATURES_FILE), `${JSON.stringify(features, null, 2)}\n`);
}

/** The --additional-features key of agent NAME. */
function agentKey(name: string): string {
    return `./${AGENT_DIR}/${name}`;
}

/**
 * All the Features DIR's sandbox gets next to its config: the recorded ones, and the agent in its
 * folder (with its options when they're recorded too). A recorded agent whose folder is gone (it was
 * swapped for another) is left out.
 */
export function extraFeatures(dir: string): JsonObject {
    const agent = agentOf(dir);
    const out = Object.fromEntries(Object.entries(recordedFeatures(dir))
        .filter(([ref]) => !ref.startsWith(`./${AGENT_DIR}/`) || (agent !== null && ref === agentKey(agent))));
    if (agent && !Object.hasOwn(out, agentKey(agent))) out[agentKey(agent)] = {};
    return out;
}

/**
 * CONFIG (a parsed devcontainer.json) with EXTRA ({ REF: options }) in its own "features": for a
 * config that names its Features itself, as a project's does (--inplace, export). A local agent's
 * "./agent/NAME" works there too, its folder being inside .devcontainer.
 */
export function withFeatures<T extends JsonObject>(config: T, extra: JsonObject): T {
    const features = isObject(config.features) ? config.features : {};
    return { ...config, features: { ...features, ...extra } };
}

/** The agents the package ships, as Features: agents/NAME/devcontainer-feature.json. */
export const AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));

/** The names of the agents in ROOT. */
export function listAgents(root: string = AGENTS_DIR): string[] {
    return existsSync(root) ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'devcontainer-feature.json')))
        .map((e) => e.name).sort() : [];
}

/** Check sandbox new's --agent value GIVEN (a name from ROOT, or none) before anything is made. */
export function checkAgent(given: string | undefined, root: string = AGENTS_DIR): void {
    if (given === undefined || given === 'none') return;
    const agents = listAgents(root);
    if (!agents.includes(given)) {
        throw new SandboxError(`--agent ${given}: no such agent; the agents are ${agents.join(', ')}, or none`);
    }
}

/**
 * The agent a new sandbox in config folder DEST (the template just copied there) gets: GIVEN
 * (--agent; none for no agent), else the template's default, its devcontainer.json's
 * customizations.podman-agent-sandbox.agent; null for none. The config is only read without GIVEN,
 * and a template with comments or trailing commas (JSONC, which sandbox otherwise leaves alone) has
 * no default it can read: refused if it seems to name one, so the agent isn't dropped silently.
 */
export function chooseAgent(dest: string, given: string | undefined): string | null {
    if (given !== undefined) return given === 'none' ? null : given;
    const file = join(dest, '.devcontainer', 'devcontainer.json');
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    let config: unknown;
    try {
        config = JSON.parse(text);
    } catch {
        if (/"agent"\s*:/.test(text)) {
            throw new SandboxError(`${file} has comments or trailing commas, so sandbox can't read its default `
                + 'agent: give --agent NAME (or --agent none)');
        }
        return null;
    }
    const agent = markerOf(config)?.agent;
    return typeof agent === 'string' ? agent : null;
}

/**
 * Give the new sandbox in DEST agent CHOSEN (chooseAgent; null for none) and return its entry for
 * sandbox-features.json ({} for none). When sandbox decides the agent (--agent GIVEN, none included,
 * or the template's default), .devcontainer/agent is emptied first: an agent folder the template
 * brought would otherwise stay next to it (two agents, refused at the next command) or stay despite
 * --agent none. A template's own agent folder, with neither, is left as the template has it.
 */
export function placeAgent(dest: string, given: string | undefined, chosen: string | null, values: OptionValues,
    root: string = AGENTS_DIR): JsonObject {
    if (given !== undefined || chosen !== null) rmSync(join(dest, '.devcontainer', AGENT_DIR), { recursive: true, force: true });
    return chosen ? addAgent(dest, chosen, values, root) : {};
}

/**
 * Put agent NAME from ROOT into the config folder DEST (.devcontainer/agent/NAME) and return its entry
 * for sandbox-features.json: its options, from the template options (VALUES) of the same name, so
 * that --option trustWorkspace=0 reaches it. A boolean option takes 1/0 or true/false.
 */
export function addAgent(dest: string, name: string, values: OptionValues, root: string = AGENTS_DIR): JsonObject {
    const src = join(root, name);
    const meta: unknown = JSON.parse(readFileSync(join(src, 'devcontainer-feature.json'), 'utf8'));
    const declared = isObject(meta) && isObject(meta.options) ? meta.options : {};
    const options: JsonObject = {};
    for (const [key, value] of Object.entries(values)) {
        const option = declared[key];
        if (!isObject(option)) continue;
        if (option.type === 'boolean') {
            if (!['0', '1', 'true', 'false'].includes(value)) {
                throw new SandboxError(`option '${key}' is a yes/no setting of agent ${name}: 1 or 0`);
            }
            options[key] = value === '1' || value === 'true';
        } else {
            options[key] = value;
        }
    }
    cpSync(src, join(dest, '.devcontainer', AGENT_DIR, name), { recursive: true });
    return { [agentKey(name)]: options };
}

/**
 * The devcontainer options that add DIR's extra Features: [] without any, and always [] for an
 * --inplace sandbox. Its config folder holds the trusted copy of the project's .devcontainer, so an
 * agent folder or sandbox-features.json there came from the project, and the trust prompt (which
 * shows devcontainer.json) didn't show them: such a config names its Features itself.
 */
export function featureArgs(dir: string): string[] {
    if (readSettings(dir)?.inplace) return [];
    const features = extraFeatures(dir);
    return Object.keys(features).length ? ['--additional-features', JSON.stringify(features)] : [];
}

/**
 * sandbox new's --feature values: REF, or REF={"option": value, ...}. REF is a published Feature's
 * reference (ghcr.io/devcontainers/features/aws-cli:1); local paths are refused, since the CLI takes
 * those only from inside .devcontainer.
 */
export function parseFeatureArgs(values: string[]): JsonObject {
    const features: JsonObject = {};
    for (const value of values) {
        const at = value.indexOf('=');
        const ref = (at < 0 ? value : value.slice(0, at)).trim();
        if (!ref) throw new SandboxError(`--feature ${value}: no Feature reference`);
        if (ref.startsWith('.') || ref.startsWith('/')) {
            throw new SandboxError(`--feature ${ref}: give a published Feature's reference (e.g. `
                + 'ghcr.io/devcontainers/features/aws-cli:1); a local Feature folder goes in the template\'s .devcontainer');
        }
        let options: unknown = {};
        if (at >= 0) {
            try {
                options = JSON.parse(value.slice(at + 1));
            } catch {
                throw new SandboxError(`--feature ${ref}: the options after = must be JSON, e.g. ${ref}='{"version": "latest"}'`);
            }
            if (!isObject(options)) throw new SandboxError(`--feature ${ref}: the options after = must be a JSON object`);
        }
        features[ref] = options;
    }
    return features;
}
