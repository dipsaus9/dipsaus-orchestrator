<context>
<item path="src/greet.ts" about="scope file">
export const greeting = (name: string) => `Hi ${name}`;
</item>
<item path="src/greet.test.ts" about="new scope path, 2 files in src, 2 changed most recently on the base">
src/cli.ts
src/greet.ts
</item>
<item path="cli" about="component cli, matches the scope, 2 of 2 files, purpose: The command line.">
src/cli.ts
src/greet.ts
</item>
</context>

<inputs>
Read these; do not change them:
- docs/voice.md
- https://example.com/style (link, not fetched)
<item path="docs/voice.md" about="input">
# Voice

Warm, short, one exclamation mark at most.
</item>
</inputs>

<dependencies>
This story builds on:
- SHOP-3 Parse CLI flags: the CLI reads its flags into one typed object.
</dependencies>

<background>
Context: the greeting follows the tone guide. Customers asked for it in the last survey.
</background>

<base_verify>
Not known: dipo has no verify result for this base commit. Whether the base commit passes verify in your sandbox is not recorded; if a failure looks unrelated to your change, check it before you spend turns on it.
</base_verify>

<story>
Id: SHOP-12
Title: Add a greeting to the CLI
Type: feature
Tier: M
</story>

<outcome>
`shop greet <name>` prints a friendly greeting in the shop's voice.
</outcome>

<criteria>
#1 `shop greet Ada` prints `Hello, Ada!`.
#2 An empty name exits with code 2 and a usage line.
</criteria>

<scope>
You may write only these paths:
- src/greet.ts
- src/greet.test.ts
</scope>

<test_plan>
Tests to write:
- #1 (unit) greet returns the greeting for a name.
Behaviour the maintainer will check by hand:
- #2 Run shop greet Ada. Expected: It prints Hello, Ada!
</test_plan>

<answers>
Q: Should the greeting end with an exclamation mark?
A: Yes, one.
</answers>

<instructions>
Keep the greeting in one exported constant.
</instructions>
