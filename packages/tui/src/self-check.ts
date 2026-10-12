// The TUI part of the hidden `dipo self-check` (DIPO-17): renders an Ink component to a PassThrough
// stream, which proves Ink, React and yoga-layout's top-level await load inside the compiled binary
// (0009 section 1).

import { PassThrough } from "node:stream";

import { Box, render, Text } from "ink";
import { createElement } from "react";

export const INK_SELF_CHECK_NAME = "ink";

const EXPECTED = "dipo self-check";

export async function checkInk(): Promise<void> {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  // Ink sizes its output from the stream's columns.
  Object.assign(stdout, { columns: 80, rows: 24 });

  const instance = render(createElement(Box, null, createElement(Text, null, EXPECTED)), {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();
  await instance.waitUntilExit();

  if (!output.includes(EXPECTED)) {
    throw new Error(
      `rendered ${JSON.stringify(output)}, expected it to contain ${JSON.stringify(EXPECTED)}`,
    );
  }
}
