// Prompt templates are imported `with { type: "text" }`: Bun gives the file's text, and
// `bun build --compile` embeds it in the binary.
declare module "*.md" {
  const text: string;
  export default text;
}
