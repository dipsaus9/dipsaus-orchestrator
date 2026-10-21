// The model route of one probe box (DIPO-264, decision 0021 section 4): a proxy outside the box that
// adds the maintainer's subscription login to the box's model requests, so the token never enters
// the box. Probe code, run by the maintainer in their own terminal; the token is read from this
// process's environment and never printed.
//
// Serve:  bun tools/box-probe/model-proxy.ts serve <listen-host> <listen-port>
// Check:  bun tools/box-probe/model-proxy.ts check <box-name>
//   `check` exports the box's filesystem and environment and reports only whether the token occurs
//   in either.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UPSTREAM = "https://api.anthropic.com";
/** Request headers that are never passed on: the box's own credentials and hop-by-hop headers. */
const DROPPED = new Set(["host", "x-api-key", "authorization", "content-length", "connection"]);
const OAUTH_BETA = "oauth-2025-04-20";
/** The only paths passed on: model requests. Account and login endpoints never get the token. */
const MODEL_PATH = /^\/v1\/messages(\/count_tokens)?$/;
/** What the check's `container` calls get: no token, only a PATH. */
const SPAWN_ENV = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

const token = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "";
delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
if (token === "") {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set in this terminal");
  process.exit(2);
}

const [mode, first, second] = process.argv.slice(2);

if (mode === "serve" && first !== undefined && second !== undefined) {
  Bun.serve({
    hostname: first,
    port: Number(second),
    async fetch(request) {
      const url = new URL(request.url);
      if (!MODEL_PATH.test(url.pathname)) {
        console.log(`${request.method} ${url.pathname} -> refused (not a model path)`);
        return new Response("not a model path", { status: 403 });
      }
      const headers = new Headers();
      request.headers.forEach((value, name) => {
        if (!DROPPED.has(name.toLowerCase())) headers.set(name, value);
      });
      headers.set("authorization", `Bearer ${token}`);
      const beta = headers.get("anthropic-beta");
      if (
        beta === null ||
        !beta
          .split(",")
          .map((part) => part.trim())
          .includes(OAUTH_BETA)
      ) {
        headers.set("anthropic-beta", beta === null ? OAUTH_BETA : `${beta},${OAUTH_BETA}`);
      }
      const response = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      console.log(`${request.method} ${url.pathname} -> ${response.status}`);
      const out = new Headers(response.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      return new Response(response.body, { status: response.status, headers: out });
    },
  });
  console.log(`ready: model proxy on ${first}:${second}`);
} else if (mode === "check" && first !== undefined) {
  const tar = join(tmpdir(), `box-probe-export-${process.pid}.tar`);
  try {
    const exported = Bun.spawnSync(["container", "export", "--output", tar, first], {
      env: SPAWN_ENV,
    });
    if (exported.exitCode !== 0) throw new Error(`container export failed: ${exported.stderr}`);
    const env = Bun.spawnSync(["container", "exec", first, "env"], { env: SPAWN_ENV });
    if (env.exitCode !== 0 || env.stdout.length === 0) {
      throw new Error("could not read the box environment; the check proves nothing");
    }
    const needle = Buffer.from(token);
    const inEnv = Buffer.from(env.stdout).includes(needle);
    const inFiles = Buffer.from(await Bun.file(tar).arrayBuffer()).includes(needle);
    console.log(`token found in the box environment: ${inEnv ? "YES" : "no"}`);
    console.log(`token found in the box files: ${inFiles ? "YES" : "no"}`);
  } finally {
    await rm(tar, { force: true });
  }
} else {
  console.error("usage: model-proxy.ts serve <listen-host> <listen-port> | check <box-name>");
  process.exit(2);
}
