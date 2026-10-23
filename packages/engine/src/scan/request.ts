// The fallback session's prompts (0014 section 1 for the shape, DIPO-310): the L1+L2 system file
// of the `scan` kind and the `scanner` role, and the task message built from the evidence bundle
// with the `scan` task template. Repository text goes in as data: every file's text has its prompt
// tags neutralised, so a README cannot close `<scan_evidence>` and start a section of its own.

import { neutraliseTags, rendered, renderSystemFile, renderTemplate } from "../prompts";
import { TASK_TEMPLATES } from "../prompts/templates";

import type { EvidenceBundle } from "./evidence";

/** The system file of every fallback session; the same bytes for every office. */
export function scanSystemFile(): string {
  return renderSystemFile("scan", "scanner");
}

function requestText(bundle: EvidenceBundle): string {
  return bundle.request
    .map((item) => {
      const head = `- ${item.capability}: ${item.status}`;
      return item.candidates.length === 0
        ? head
        : [head, ...item.candidates.map((candidate) => `  - candidate: ${candidate}`)].join("\n");
    })
    .join("\n");
}

function evidenceText(bundle: EvidenceBundle): string {
  const parts = bundle.items.map((item) => {
    const attribute =
      item.path === null ? `kind="${item.kind}"` : `path=${JSON.stringify(item.path)}`;
    return `<scan_file ${neutraliseTags(attribute)}>\n${neutraliseTags(item.text)}\n</scan_file>`;
  });
  if (bundle.cut.length > 0) {
    parts.push(neutraliseTags(`Cut or left out for the size budget: ${bundle.cut.join(", ")}`));
  }
  return parts.join("\n\n");
}

/** The task message of a fallback session: the request and the evidence. */
export function scanTaskMessage(bundle: EvidenceBundle): string {
  return renderTemplate(TASK_TEMPLATES.scan, {
    capabilities: requestText(bundle),
    evidence: rendered(evidenceText(bundle)),
  });
}
