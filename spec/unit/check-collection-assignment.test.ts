import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("what the check-collection-assignment command is allowed to do", () => {
  const packageJson = readFileSync("package.json", "utf8");
  const preCommit = readFileSync(".pre-commit-config.yaml", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const command = readFileSync(
    "scripts/check-collection-assignment.ts",
    "utf8"
  );
  const scripts = JSON.parse(packageJson).scripts as Record<string, string>;

  it("is a command anyone can run, and needs no credential", () => {
    expect(scripts["check:collection-assignment"]).toContain(
      "scripts/check-collection-assignment.ts"
    );
    // No `--env-file-if-exists`, unlike the two commands that need Shopify or
    // Discourse — this reads only committed files, which is what lets it gate
    // CI and a pre-commit hook.
    expect(scripts["check:collection-assignment"]).not.toContain(
      "--env-file-if-exists"
    );
  });

  it("runs in CI", () => {
    expect(ci).toContain("check:collection-assignment");
  });

  it("runs as a pre-commit hook", () => {
    expect(preCommit).toContain("check:collection-assignment");
  });

  it("makes no network request and holds no decision of its own", () => {
    // The decision — which rows are undecided — lives in
    // `undecidedAssignments`, not here. This file reads, calls it, and prints.
    expect(command).not.toContain("fetch(");
    expect(command).toContain("undecidedAssignments(");
  });

  it("names the affected rows in its failure rather than just a count", () => {
    // The failure a curator reads has to point at rows, not just say how many.
    expect(command).toContain("row.field");
    expect(command).toMatch(/legacyPnums|legacyText/);
  });
});
