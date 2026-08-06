import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  exportFileName,
  MAX_DATA_ROWS,
  parseCsv,
  readSheetTab,
  SHEET_TABS,
  sheetCsvUrl,
  SheetExportError,
  sheetRowsFrom,
  tabNamed,
  WORKBOOK_ID_VAR,
} from "../../scripts/lib/sheet-export";

// Fixtures are real rows fetched from the real workbook, header rows included,
// with the sleeping.com Suggested URLs left exactly as the spreadsheet holds
// them. The endpoint quotes every field, uses LF endings and emits no final
// newline, so the fixtures do the same — a parser that only works on tidier CSV
// than this would pass its tests and fail in use.

const MACHINE_HEADER = `"Value","Text","URL","Suggested Title","Suggested URL"`;
const MASK_HEADER = MACHINE_HEADER;
const HUMIDIFIER_HEADER = `"Value","Text",""`;

const MACHINE_CSV = [
  MACHINE_HEADER,
  `"4872","AirCurve 10 VAuto BiLevel Machine with HumidAir Heated Humidifier","https://sleeping.com/products/aircurve-10-vauto-bilevel-machine","AirCurve 10 VAuto BiLevel Machine","https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine"`,
  `"6092","AirCurve 10 Vauto USA C2C CO","https://sleeping.com/products/aircurve-10-vauto-bilevel-machine","AirCurve 10 VAuto BiLevel Machine","https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine"`,
].join("\n");

// The third row's Text column holds a comma inside its quotes, and the second
// row's URL column is empty. Both are real and both break a naive split(",").
const MASK_CSV = [
  MASK_HEADER,
  `"5954","AirMini Mask Setup Pack with AirFit N30 Nasal CPAP Mask","https://cpap.com/products/airmini-mask-setup-pack-n30-nasal-mask","AirMini Mask Setup Pack with N30","https://www.sleeping.com/products/airmini-mask-setup-pack-n30-nasal-mask"`,
  `"4499","Amara Full Face CPAP Mask with Gel & Silicone Cushions","","Amara Full Face CPAP Mask","https://www.sleeping.com/products/amara-full-face-cpap-mask-with-headgear"`,
  `"5479","DreamWear Full Face CPAP Mask with Headgear - Fit Pack (S, M, MW, L Cushions with Medium Frame)","https://cpap.com/products/dreamwear-full-face-cpap-mask-with-headgear","DreamWear Full Face CPAP Mask","https://www.sleeping.com/products/dreamwear-full-face-cpap-mask-with-headgear"`,
].join("\n");

const HUMIDIFIER_CSV = [
  HUMIDIFIER_HEADER,
  `"5027","DreamStation Heated Humidifier","https://sleeping.com/products/dreamstation-heated-humidifier"`,
  `"24","HC150 Heated Humidifier With Hose, 2 Chambers and Stand","https://www.sleeping.com/search?q=humidifiers&options%5Bprefix%5D=last"`,
].join("\n");

const machine = tabNamed("user_machine");
const mask = tabNamed("user_mask");
const humidifier = tabNamed("user_humidifier");

describe("parseCsv", () => {
  it("keeps a comma that sits inside a quoted field", () => {
    const rows = parseCsv(MASK_CSV);

    expect(rows[3][1]).toBe(
      "DreamWear Full Face CPAP Mask with Headgear - Fit Pack (S, M, MW, L Cushions with Medium Frame)"
    );
    expect(rows[3]).toHaveLength(5);
  });

  it("reads a doubled quote as one literal quote", () => {
    const rows = parseCsv(`"a","6"" hose","c"`);

    expect(rows).toEqual([["a", '6" hose', "c"]]);
  });

  it("keeps an empty quoted field as an empty string rather than dropping it", () => {
    const rows = parseCsv(MASK_CSV);

    expect(rows[2][2]).toBe("");
    expect(rows[2]).toHaveLength(5);
  });

  it("keeps a newline that sits inside a quoted field", () => {
    const rows = parseCsv(`"one","two\nstill two"\n"three","four"`);

    expect(rows).toEqual([
      ["one", "two\nstill two"],
      ["three", "four"],
    ]);
  });

  it("reads CRLF and LF endings the same way", () => {
    expect(parseCsv(`"a","b"\r\n"c","d"`)).toEqual(
      parseCsv(`"a","b"\n"c","d"`)
    );
  });

  it("does not invent a trailing row, whether or not the text ends in a newline", () => {
    expect(parseCsv(`"a"\n"b"`)).toHaveLength(2);
    expect(parseCsv(`"a"\n"b"\n`)).toHaveLength(2);
  });

  it("refuses text that ends inside a quoted field", () => {
    expect(() => parseCsv(`"a","unterminated`)).toThrow(SheetExportError);
    expect(() => parseCsv(`"a","unterminated`)).toThrow(/quoted field/);
  });
});

describe("the tab allowlist", () => {
  it("holds exactly the three user_* tabs", () => {
    expect(SHEET_TABS.map((tab) => tab.tab)).toEqual([
      "user_machine",
      "user_mask",
      "user_humidifier",
    ]);
  });

  it("refuses the tabs that hold personal data, by name", () => {
    // The two tabs this command must never touch. Roughly 124,000 real
    // usernames and email addresses between them.
    for (const forbidden of ["Discourse", "user-list-260410-001810"]) {
      expect(() => tabNamed(forbidden)).toThrow(SheetExportError);
      expect(() => tabNamed(forbidden)).toThrow(/not in the allowlist/);
    }
  });

  it("refuses a tab whose name merely resembles an allowlisted one", () => {
    for (const nearMiss of ["user_machines", "User_Machine", "user_machine "]) {
      expect(() => tabNamed(nearMiss)).toThrow(SheetExportError);
    }
  });

  it("names each tab's Custom User Field and the columns it reads", () => {
    expect(machine.userFieldName).toBe("Machine");
    expect(machine.titleColumn).toBe("Suggested Title");
    expect(machine.urlColumn).toBe("Suggested URL");
    expect(mask.userFieldName).toBe("Mask");

    // No Suggested columns at all, which is the state ADR-0012 describes.
    expect(humidifier.userFieldName).toBe("Humidifier");
    expect(humidifier.titleColumn).toBeNull();
    expect(humidifier.urlColumn).toBeNull();
  });

  it("addresses a tab by name, never by the gid the workbook can reassign", () => {
    const url = sheetCsvUrl("WORKBOOK", machine);

    expect(url).toContain("/spreadsheets/d/WORKBOOK/gviz/tq");
    expect(url).toContain("sheet=user_machine");
    expect(url).toContain("tqx=out%3Acsv");
    expect(url).not.toContain("gid=");
  });

  it("names each export after its tab, so the file says where it came from", () => {
    expect(SHEET_TABS.map(exportFileName)).toEqual([
      "user_machine.csv",
      "user_mask.csv",
      "user_humidifier.csv",
    ]);
  });
});

describe("readSheetTab", () => {
  it("accepts the real header row and returns only the data rows", () => {
    expect(readSheetTab(machine, MACHINE_CSV)).toHaveLength(2);
    expect(readSheetTab(mask, MASK_CSV)).toHaveLength(3);
  });

  it("accepts the humidifier tab, whose third column header is blank", () => {
    expect(readSheetTab(humidifier, HUMIDIFIER_CSV)).toHaveLength(2);
  });

  it("aborts when a column has been renamed", () => {
    const renamed = MACHINE_CSV.replace(
      `"Suggested Title"`,
      `"Suggested Titles"`
    );

    expect(() => readSheetTab(machine, renamed)).toThrow(SheetExportError);
    expect(() => readSheetTab(machine, renamed)).toThrow(
      /unexpected header row/
    );
  });

  it("aborts when an expected column is missing", () => {
    const missing = MACHINE_CSV.split("\n")
      .map((line) =>
        line.replace(`,"Suggested URL"`, "").replace(/,"https:[^"]*"$/, "")
      )
      .join("\n");

    expect(() => readSheetTab(machine, missing)).toThrow(
      /unexpected header row/
    );
  });

  it("aborts when a column has been added", () => {
    const added = MACHINE_CSV.replace(
      MACHINE_HEADER,
      `${MACHINE_HEADER},"Notes"`
    );

    expect(() => readSheetTab(machine, added)).toThrow(/unexpected header row/);
  });

  it("aborts when the columns have been reordered", () => {
    const reordered = MACHINE_CSV.replace(
      MACHINE_HEADER,
      `"Value","Text","URL","Suggested URL","Suggested Title"`
    );

    expect(() => readSheetTab(machine, reordered)).toThrow(
      /unexpected header row/
    );
  });

  it("aborts on an empty response, which is how a renamed tab presents", () => {
    // The endpoint answers 200 with no body for a tab it cannot find, so an
    // empty response is indistinguishable from success unless it is refused.
    expect(() => readSheetTab(machine, "")).toThrow(SheetExportError);
    expect(() => readSheetTab(machine, "   \n ")).toThrow(/renamed or removed/);
  });

  it("aborts when a tab has grown to a size these tabs never reach", () => {
    const row = `"1","Text","https://example.com","Title","https://example.com"`;
    const oversized = [
      MACHINE_HEADER,
      ...Array.from({ length: MAX_DATA_ROWS + 1 }, () => row),
    ].join("\n");

    expect(() => readSheetTab(machine, oversized)).toThrow(SheetExportError);
    expect(() => readSheetTab(machine, oversized)).toThrow(/exceeds the/);
  });

  it("aborts when a cell holds something shaped like an email address", () => {
    const contaminated = MACHINE_CSV.replace(
      "AirCurve 10 Vauto USA C2C CO",
      "someone@example.com"
    );

    expect(() => readSheetTab(machine, contaminated)).toThrow(SheetExportError);
    expect(() => readSheetTab(machine, contaminated)).toThrow(
      /shaped like an email address/
    );
  });

  it("does not repeat the offending value in the refusal", () => {
    const contaminated = MACHINE_CSV.replace(
      "AirCurve 10 Vauto USA C2C CO",
      "someone@example.com"
    );

    // The whole point is to keep that string out of the repository. A log line
    // or a CI transcript is the repository's neighbour, not its opposite.
    expect(() => readSheetTab(machine, contaminated)).toThrow(
      /^(?!.*someone@example\.com)/s
    );
  });

  it("does not mistake a real product row for personal data", () => {
    expect(() => readSheetTab(machine, MACHINE_CSV)).not.toThrow();
    expect(() => readSheetTab(mask, MASK_CSV)).not.toThrow();
    expect(() => readSheetTab(humidifier, HUMIDIFIER_CSV)).not.toThrow();
  });
});

describe("sheetRowsFrom", () => {
  it("emits the Suggested Title and Suggested URL verbatim, under the field name", () => {
    expect(sheetRowsFrom(machine, MACHINE_CSV)).toEqual([
      {
        userFieldName: "Machine",
        suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
        suggestedUrl:
          "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
      },
      {
        userFieldName: "Machine",
        suggestedTitle: "AirCurve 10 VAuto BiLevel Machine",
        suggestedUrl:
          "https://www.sleeping.com/products/aircurve-10-vauto-bilevel-machine",
      },
    ]);
  });

  it("leaves the duplicates in, because collapsing them is the transform's job", () => {
    const rows = sheetRowsFrom(machine, MACHINE_CSV);

    expect(rows).toHaveLength(2);
    expect(rows[0].suggestedTitle).toBe(rows[1].suggestedTitle);
  });

  it("leaves the sleeping.com host alone", () => {
    // ADR-0009: the shipped URL comes from Shopify, and no domain swap happens
    // anywhere in this pipeline. If this export rewrote the host, the evidence
    // that the swap was abandoned would be gone.
    for (const row of sheetRowsFrom(mask, MASK_CSV)) {
      expect(row.suggestedUrl).toContain("sleeping.com");
    }
  });

  it("reads the Suggested columns by header, not by position", () => {
    const shuffled = MASK_CSV.split("\n")
      .map((line) => parseCsv(line)[0])
      .map((cells) => [cells[3], cells[4], cells[0], cells[1], cells[2]]);
    const headerFirst = shuffled[0];

    // Proof that the header allowlist is what pins the columns down: the same
    // five columns in a different order is refused, not silently misread.
    expect(headerFirst).toEqual([
      "Suggested Title",
      "Suggested URL",
      "Value",
      "Text",
      "URL",
    ]);
    const rewritten = shuffled
      .map((cells) => cells.map((cell) => `"${cell}"`).join(","))
      .join("\n");
    expect(() => sheetRowsFrom(mask, rewritten)).toThrow(
      /unexpected header row/
    );
  });

  it("yields no rows for a tab with no Suggested columns, but still validates it", () => {
    expect(sheetRowsFrom(humidifier, HUMIDIFIER_CSV)).toEqual([]);
    expect(() => sheetRowsFrom(humidifier, MACHINE_CSV)).toThrow(
      /unexpected header row/
    );
  });
});

describe("what each file is allowed to do", () => {
  // Read relative to the repository root, which is vitest's working directory.
  // `import.meta.url` would be the obvious way to resolve these and does not
  // typecheck here — the shared Discourse tsconfig builds to CommonJS output,
  // where the meta-property is not allowed.
  const lib = readFileSync("scripts/lib/sheet-export.ts", "utf8");
  const command = readFileSync("scripts/export-sheet.ts", "utf8");

  it("keeps the allowlist module free of network and filesystem access", () => {
    expect(lib).not.toMatch(/^\s*import (?!type )/m);
    expect(lib).not.toMatch(/from "node:/);
    expect(lib).not.toMatch(/\brequire\s*\(/);
    expect(lib).not.toMatch(/\bfetch\s*\(/);
  });

  it("leaves the command unable to name a tab or build a URL of its own", () => {
    // Not style. If the command could write a tab name or a sheet URL itself,
    // the allowlist would be a convention rather than the only way through.
    for (const tab of SHEET_TABS) {
      expect(command).not.toContain(tab.tab);
    }
    expect(command).not.toContain("gviz");
    expect(command).not.toContain("docs.google.com");
    expect(command).toContain("SHEET_TABS");
  });

  it("keeps the workbook id out of the repository", () => {
    // The workbook is a public link to real customer email addresses and this
    // repository is public, so the id is configuration, not a constant.
    expect(WORKBOOK_ID_VAR).toBe("SHEET_WORKBOOK_ID");
    expect(lib).not.toMatch(/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/);
    expect(command).not.toContain(WORKBOOK_ID_VAR);
    expect(command).toContain("process.env[WORKBOOK_ID_VAR]");
  });
});
