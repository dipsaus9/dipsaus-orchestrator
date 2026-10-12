// `srt`'s vendored Linux helper, imported `with { type: "file" }`: Bun gives its path, and
// `bun build --compile` embeds it in the binary.
declare module "@anthropic-ai/sandbox-runtime/vendor/seccomp/*/apply-seccomp" {
  const path: string;
  export default path;
}
