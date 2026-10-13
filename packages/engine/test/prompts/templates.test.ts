// Templates hold named slots only (DIPO-47 AC #1, 0014 section 1).

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { renderTemplate, slotsOf, templateProblems } from "../../src/prompts";

const PROMPTS_DIR = join(import.meta.dir, "../../src/prompts");

function templateFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? templateFiles(join(dir, entry.name))
        : entry.name.endsWith(".md")
          ? [join(dir, entry.name)]
          : [],
    )
    .toSorted();
}

describe("templates", () => {
  it("holds named slots only in every template file", () => {
    const files = templateFiles(PROMPTS_DIR);
    expect(files.length).toBeGreaterThan(10);
    const problems = files.flatMap((file) =>
      templateProblems(readFileSync(file, "utf8")).map(
        (problem) => `${relative(PROMPTS_DIR, file)}: ${problem}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it("fails a template with a conditional or loop", () => {
    expect(templateProblems("{{#if criteria}}x{{/if}}")).toEqual(["{{#if criteria}}", "{{/if}}"]);
    expect(templateProblems("{{#each items}}{{this}}{{/each}}")).toHaveLength(3);
    expect(templateProblems("{{else}}")).toEqual(["{{else}}"]);
    expect(templateProblems("{{^empty}}")).toEqual(["{{^empty}}"]);
    expect(templateProblems("{% for x in y %}{% endfor %}")).toHaveLength(4);
    expect(templateProblems("<% if (x) { %>")).toHaveLength(2);
    expect(templateProblems("${criteria}")).toEqual(["${"]);
    expect(templateProblems("{{ criteria }}")).toEqual(["{{ criteria }}"]);
    expect(templateProblems("<criteria>\n{{criteria}}\n</criteria>")).toEqual([]);
  });

  it("refuses to render a template with logic", () => {
    expect(() => renderTemplate("{{#if a}}{{a}}{{/if}}", { a: "x" })).toThrow(
      "template holds syntax other than named slots",
    );
  });

  it("fills slots and checks that slots and values match", () => {
    expect(slotsOf("{{b}} {{a}} {{b}}")).toEqual(["a", "b"]);
    expect(renderTemplate("<x>\n{{a}}\n</x>\n", { a: "1\r\n2" })).toBe("<x>\n1\n2\n</x>");
    expect(() => renderTemplate("{{a}} {{b}}", { a: "1" })).toThrow("without a value: b");
    expect(() => renderTemplate("{{a}}", { a: "1", c: "2" })).toThrow("without a template slot: c");
  });

  it("leaves out a line that holds only an empty slot", () => {
    expect(renderTemplate("<x>\n{{a}}\n{{b}}\n</x>", { a: "", b: "kept" })).toBe("<x>\nkept\n</x>");
  });

  it("never re-reads slot syntax inside a value", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}} $& $1" })).toBe("{{b}} $& $1");
  });
});
