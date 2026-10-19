<changes>
Changed paths, with added and removed lines:
- assets/logo.png (binary)
- src/greet.test.ts (+4 -0)
- src/greet.ts (+1 -1)
</changes>

<diff>
diff --git a/src/greet.ts b/src/greet.ts
index 1111111..2222222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,3 @@
 // The greeting.
-export const greeting = (name: string) => `Hi ${name}`;
+export const greeting = (name: string) => `Hello, ${name}!`;
 
diff --git a/src/greet.test.ts b/src/greet.test.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/greet.test.ts
@@ -0,0 +1,4 @@
+import { greeting } from "./greet";
+test("greets", () => {
+  expect(greeting("Ada")).toBe("Hello, Ada!");
+});
</diff>

<gate_changes>
This branch changed the gate commands:
- scripts.test: "bun test" -> "bun test --bail"
</gate_changes>

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
The change may touch only these paths:
- src/greet.ts
- src/greet.test.ts
</scope>

<test_plan>
Entries, numbered as a test finding names them:
#1 automated: (unit) greet returns the greeting for a name.
#2 manual: Run shop greet Ada. Expected: It prints Hello, Ada!
</test_plan>

<answers>
Q: Should the greeting end with an exclamation mark?
A: Yes, one.
</answers>
