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

  it("locates the affected rows in its failure rather than just a count", () => {
    // The failure a curator reads has to point at rows, not just say how many.
    // `row.field` is a Managed Field name and `index + 2` is the Sheet row, so
    // together they locate the row without quoting any of it.
    expect(command).toContain("row.field");
    expect(command).toContain("index + 2");
  });

  it("locates those rows without echoing a cell it read", () => {
    // This command's output is a public artifact: it runs in CI on a public
    // repository. Every column below is workbook content read across the
    // boundary, and `Legacy Text` is free text a curator typed into a bulletin
    // board. Naming a row is a coordinate; quoting one is a disclosure.
    for (const column of [
      "legacyPnums",
      "legacyText",
      "profileLinkValue",
      "rationale",
      "override",
      "recommendedCollectionTitle",
      "recommendedCollectionUrl",
      "baseNameSource",
      "confidence",
    ]) {
      expect(command).not.toContain(column);
    }

    // `refuseArguments` does quote what it was given, which is the operator's
    // own argv rather than anything read out of the workbook — so the ban is
    // on the columns above, not on quoting as such.
  });
});
