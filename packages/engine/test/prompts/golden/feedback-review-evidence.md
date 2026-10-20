The evidence of these blocking findings did not check out against the reviewed commit:
- finding 1 (correctness): line 7 of src/greet.ts is not inside a hunk of the story's diff
- finding 2 (security): src/cli.ts is not a changed path of the story's diff
- finding 4 (test): test-plan entry #2 is manual, not automated
A scope, security or correctness finding needs a changed file, a line inside a hunk of the story's diff and that line quoted exactly. A test finding needs the number of an automated test-plan entry.
Check each of them again, then return the whole review report in the schema again, through the structured output. A blocking finding whose evidence still does not check out is kept as advisory and marked unverified.
