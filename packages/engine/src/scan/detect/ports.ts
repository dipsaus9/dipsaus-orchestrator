// Dev ports (0013 section 3, last rows): an explicit port in the dev script or dev server config,
// including a value imported from a config module (medium confidence), else the framework
// default (low). Fixed ports are flagged because parallel worktrees running `dev` collide.

import { baseName, dirOf, isViteConfig, joinPath, type Manifest } from "./manifest";
import type { DevPort, Probe } from "./types";

/** A root `dev` that runs the workspace packages' own `dev` scripts. */
const DELEGATES =
  /\b(?:pnpm|npm|yarn|bun)\b[^&|;]*(?:\s-r\b|--recursive|--filter\b|\s-F\b|--workspaces?\b|\bworkspaces\b)|\b(?:turbo|nx|lerna)\b/;

const SCRIPT_PORT = /(?:--port[=\s]+|(?:^|\s)-p\s+)(\d{2,5})\b/;
const USES_PORT_ENV = /\$\{?PORT\b|\benv\.PORT\b|\benv\[\s*["']PORT["']\s*\]/;
const LITERAL_PORT = /\bport\s*:\s*(\d{2,5})\b/g;
const MEMBER_PORT = /\bport\s*:\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
const WRANGLER_PORT = /\bport["']?\s*[=:]\s*(\d{2,5})\b/;

type Site = { dir: string; manifestPath: string; dev: string };

type Framework = { name: string; port: number; honoursPort: boolean };

function frameworkOf(dev: string): Framework | null {
  if (/\bnext\s+dev\b/.test(dev)) return { name: "Next", port: 3000, honoursPort: true };
  if (/\bwrangler\s+dev\b/.test(dev)) return { name: "wrangler", port: 8787, honoursPort: false };
  if (/\breact-router\s+dev\b|\bvite\b(?!\s+(?:build|preview)\b)/.test(dev)) {
    return { name: "Vite", port: 5173, honoursPort: false };
  }
  return null;
}

/** Finds `prop: N` inside `obj = { ... }` in one of the imported modules. */
function memberValue(
  modules: readonly string[],
  texts: Probe["texts"],
  obj: string,
  prop: string,
): { port: number; module: string } | null {
  const objectPattern = new RegExp(`\\b${obj.replace(/\$/g, "\\$")}\\s*=\\s*\\{([^}]*)\\}`);
  const propPattern = new RegExp(
    `(?:^|[\\s,{])["']?${prop.replace(/\$/g, "\\$")}["']?\\s*:\\s*(\\d{2,5})\\b`,
  );
  for (const module of modules) {
    const body = objectPattern.exec(texts[module] ?? "")?.[1];
    const value = body === undefined ? undefined : propPattern.exec(body)?.[1];
    if (value !== undefined) return { port: Number(value), module };
  }
  return null;
}

function sitesOf(
  root: Manifest,
  workspaces: readonly { dir: string; manifest: Manifest }[],
): Site[] {
  const rootDev = root.scripts["dev"];
  if (rootDev === undefined) return [];
  if (workspaces.length > 0 && DELEGATES.test(rootDev)) {
    return workspaces.flatMap(({ dir, manifest }) => {
      const dev = manifest.scripts["dev"];
      return dev === undefined ? [] : [{ dir, manifestPath: joinPath(dir, "package.json"), dev }];
    });
  }
  return [{ dir: "", manifestPath: "package.json", dev: rootDev }];
}

export function detectPorts(
  probe: Probe,
  root: Manifest,
  workspaces: readonly { dir: string; manifest: Manifest }[],
): DevPort[] {
  const ports: DevPort[] = [];
  const add = (port: DevPort) => {
    if (!ports.some((p) => p.dir === port.dir && p.port === port.port)) ports.push(port);
  };
  for (const site of sitesOf(root, workspaces)) {
    const dir = site.dir === "" ? "." : site.dir;
    const configs = Object.keys(probe.texts)
      .filter((path) => dirOf(path) === site.dir)
      .filter((path) => isViteConfig(baseName(path)) || baseName(path).startsWith("wrangler."))
      .toSorted();
    const honoursPort =
      USES_PORT_ENV.test(site.dev) ||
      configs.some((path) => USES_PORT_ENV.test(probe.texts[path] ?? ""));
    const before = ports.length;

    const scriptPort = SCRIPT_PORT.exec(site.dev)?.[1];
    if (scriptPort !== undefined) {
      add({
        port: Number(scriptPort),
        dir,
        source: "declared",
        confidence: "medium",
        evidence: `${site.manifestPath} scripts.dev`,
        fixedInCode: true,
        honoursPort,
      });
    }
    for (const config of configs) {
      const text = probe.texts[config] ?? "";
      const literal = isViteConfig(baseName(config))
        ? [...text.matchAll(LITERAL_PORT)].map((m) => m[1])
        : [WRANGLER_PORT.exec(text)?.[1]];
      for (const value of literal) {
        if (value === undefined) continue;
        add({
          port: Number(value),
          dir,
          source: "declared",
          confidence: "medium",
          evidence: config,
          fixedInCode: true,
          honoursPort,
        });
      }
      for (const match of text.matchAll(MEMBER_PORT)) {
        const [, obj, prop] = match;
        if (obj === undefined || prop === undefined) continue;
        const found = memberValue(probe.configImports[config] ?? [], probe.texts, obj, prop);
        if (found === null) continue;
        add({
          port: found.port,
          dir,
          source: "declared",
          confidence: "medium",
          evidence: `${config} (${obj}.${prop} from ${found.module})`,
          fixedInCode: true,
          honoursPort,
        });
      }
    }

    if (ports.length === before) {
      const framework = frameworkOf(site.dev);
      if (framework !== null) {
        add({
          port: framework.port,
          dir,
          source: "default",
          confidence: "low",
          evidence: `${framework.name} default (${site.manifestPath} scripts.dev)`,
          fixedInCode: false,
          honoursPort: framework.honoursPort || honoursPort,
        });
      }
    }
  }
  return ports;
}
