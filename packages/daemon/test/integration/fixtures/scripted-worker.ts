// The scripted worker of the re-attach test (DIPO-316): it prints a Claude `system/init` line for
// the planned session and model, then one status line every 100 ms, until it is stopped. Its
// output keeps coming while no daemon runs, so the next daemon has lines to catch up on. It ends
// by itself when its worker host is gone or after two minutes, so a failed test leaves nothing
// running.

const session = process.env["SCRIPTED_SESSION"] ?? "session-1";
const model = process.env["SCRIPTED_MODEL"] ?? "haiku";

const line = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

line({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: session,
  tools: ["Read"],
  mcp_servers: [],
  model,
  permissionMode: "default",
  slash_commands: [],
  apiKeySource: "none",
  claude_code_version: "2.1.296",
  output_style: "default",
  agents: [],
  skills: [],
  plugins: [],
  uuid: "uuid-0",
});

const host = process.ppid;
for (let n = 1; n <= 1200 && process.ppid === host; n += 1) {
  line({
    type: "system",
    subtype: "status",
    status: "requesting",
    session_id: session,
    uuid: `uuid-${n}`,
  });
  await Bun.sleep(100);
}
