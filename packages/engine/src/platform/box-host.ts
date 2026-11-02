// The Bun side of the box login (DIPO-269, 0004 amendment c: engine code reaches `Bun.spawn` and
// `Bun.serve` only through the platform module): the terminal spawn that lets `security` ask the
// maintainer for the token itself, and the HTTP listener of the model proxy.

import type { ListenHttp } from "../box/model-proxy";
import { peerAddress } from "./peer";
import type { SpawnInteractive } from "../box/token";

/**
 * Runs a program with this process's terminal as its stdin, stdout and stderr; dipo reads nothing
 * the program reads or prints.
 */
export const systemSpawnInteractive: SpawnInteractive = async (options) => {
  const child = Bun.spawn({
    cmd: [...options.cmd],
    env: { ...options.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await child.exited;
  return {
    code: child.signalCode === null ? child.exitCode : null,
    signal: child.signalCode ?? null,
  };
};

/**
 * An HTTP listener on one address. Idle connections are not cut, since a model answer may stream
 * with long pauses. Never in development mode, and an error the handler did not catch becomes a
 * plain 500 with fixed text, so no stack or error message reaches a box. The handler gets the
 * peer's address as the connection shows it (DIPO-425), never one a request names.
 */
export const systemListenHttp: ListenHttp = (options) => {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    idleTimeout: 0,
    development: false,
    maxRequestBodySize: options.maxRequestBodyBytes,
    fetch: (request, bun) => options.fetch(request, peerAddress(bun.requestIP(request)?.address)),
    error: () =>
      new Response("model proxy error\n", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
  });
  return {
    port: server.port ?? options.port,
    stop: () => server.stop(true),
  };
};
