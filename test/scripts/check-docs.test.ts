import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDocumentation } from "../../scripts/check-docs";

test("documentation validation follows rendered links and GitHub heading anchors", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-docs-"));
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), '[guide](docs/guide.md#same-1)\n\n```md\n[example](missing.md)\n```\n');
    writeFileSync(join(root, "docs/guide.md"), '# Same\n# Same\n\n[home](https://github.com/vkalipat/kiln/blob/main/README.md)\n');
    expect(inspectDocumentation(root, ["README.md", "docs/guide.md"]).problems).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("documentation validation rejects missing anchors, unpublished files and absent site assets", () => {
  const root = mkdtempSync(join(tmpdir(), "kiln-docs-"));
  try {
    mkdirSync(join(root, "site"));
    writeFileSync(join(root, "README.md"), '[anchor](#missing)\n[local only](private.md)\n');
    writeFileSync(join(root, "private.md"), "local draft");
    writeFileSync(join(root, "site/index.html"), '<img src="missing.svg"><a href="#intro">Intro</a><h1 id="intro">Kiln</h1>');
    const result = inspectDocumentation(root, ["README.md", "site/index.html"]);
    expect(result.problems).toHaveLength(3);
    expect(result.problems.join("\n")).toContain("target is not published");
    expect(result.problems.join("\n")).toContain("missing anchor");
    expect(result.problems.join("\n")).toContain("missing target");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
