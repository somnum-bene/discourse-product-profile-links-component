import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_TABS,
  assignmentRowsFrom,
  assignmentTabNamed,
  columnLetter,
  EXPORT_TABS,
  exportFileName,
  MAX_DATA_ROWS,
  parseCsv,
  readSheetTab,
  SHEET_TABS,
  SheetExportError,
  sheetRowsFrom,
  type SheetTab,
  sheetTabFor,
  sheetValuesUrl,
  tabNamed,
  valuesToCsv,
  WORKBOOK_ID_VAR,
} from "../../scripts/lib/sheet-export";

// Fixtures are real rows fetched from the real workbook, header rows included,
// with the sleeping.com Suggested URLs left exactly as the spreadsheet holds
// them. The endpoint quotes every field, uses LF endings and emits no final
// newline, so the fixtures do the same — a parser that only works on tidier CSV
// than this would pass its tests and fail in use.

const MACHINE_HEADER = `"Value","Text","URL","Suggested Title","Suggested URL"`;
const MASK_HEADER = MACHINE_HEADER;
const NO_TITLE_HEADER = `"Value","Text",""`;

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

// No tab in the current allowlist has this shape — both `user_machine` and
// `user_mask` curate Suggested Titles — but the allowlist has held one before
// (`user_humidifier`, retired by ADR-0022) and nothing stops a future tab from
// exporting for provenance only, so `readSheetTab` and `sheetRowsFrom` still
// have to handle a tab whose `titleColumn`/`urlColumn` are null. A synthetic
// tab, rather than a real allowlist entry, is what exercises that without
// resurrecting a retired one.
const NO_TITLE_CSV = [
  NO_TITLE_HEADER,
  `"5027","DreamStation Heated Humidifier","https://sleeping.com/products/dreamstation-heated-humidifier"`,
  `"24","HC150 Heated Humidifier With Hose, 2 Chambers and Stand","https://www.sleeping.com/search?q=humidifiers&options%5Bprefix%5D=last"`,
].join("\n");

// The curation tab, in the column order locked on #26. The first row is a real
// seeded one; the second exercises the two columns that make this tab not a
// SheetTab — a filled `Override` sitting beside a `Recommended Collection URL`
// it disagrees with, under a `Disposition` that is not `undecided`. Both hold
// values that could really be on the tab: 6402/6404/6407/6414 are dropped
// outright per #32 and never reach it, so a fixture using them would encode a
// row the schema forbids.
const ASSIGNMENT_HEADER = [
  "Field",
  "Legacy PNum(s)",
  "Legacy Text",
  "Base Name Source",
  "Profile Link Value",
  "Recommended Collection Title",
  "Recommended Collection URL",
  "Confidence",
  "Rationale",
  "Override",
  "Disposition",
]
  .map((header) => `"${header}"`)
  .join(",");

const ASSIGNMENT_CSV = [
  ASSIGNMENT_HEADER,
  `"Machine","6391","REFURB AirCurve 11 BiPAP ASV","Suggested Title","AirCurve 11 BiPAP ASV (Discontinued)","BiPAP Machines","https://www.cpap.com/collections/bipap-machines","High","No active Shopify product; BiPAP is the nearest live collection.","","undecided"`,
  `"Mask","5854, 5794","Legacy Full Face Masks, all sizes","Text","Legacy Full Face Masks, all sizes (Discontinued)","Full Face Masks","https://www.cpap.com/collections/full-face-cpap-masks","Medium","A catch-all naming no one product.","https://www.cpap.com/collections/cpap-full-face-masks","collection"`,
].join("\n");

const machine = tabNamed("user_machine");
const mask = tabNamed("user_mask");
const assignment = assignmentTabNamed("collection-assignment");
const noTitleTab: SheetTab = {
  tab: "user_no_title",
  userFieldName: "NoTitle",
  headers: ["Value", "Text", ""],
  titleColumn: null,
  urlColumn: null,
};

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

  it("ignores a byte order mark at the start of the text", () => {
    // Google Sheets' File → Download → CSV writes one; the `gviz` endpoint does
    // not. A BOM is an encoding marker rather than data, and leaving it in
    // makes the first header cell `\ufeffValue`, which fails the header guard
    // with a message about a renamed column — a true refusal for a false
    // reason, on a file that is in fact exactly right.
    expect(parseCsv(`\ufeff"a","b"`)).toEqual([["a", "b"]]);
    expect(parseCsv(`\ufeffa,b`)).toEqual([["a", "b"]]);
  });

  it("keeps a byte order mark that is not at the start", () => {
    // Only the leading one is an encoding marker. Anywhere else it is a
    // character the sheet holds, and this parser does not edit cell contents.
    expect(parseCsv(`"a","\ufeffb"`)).toEqual([["a", "\ufeffb"]]);
  });

  it("refuses text that ends inside a quoted field", () => {
    expect(() => parseCsv(`"a","unterminated`)).toThrow(SheetExportError);
    expect(() => parseCsv(`"a","unterminated`)).toThrow(/quoted field/);
  });
});

describe("the tab allowlist", () => {
  it("holds exactly the two user_* tabs", () => {
    expect(SHEET_TABS.map((tab) => tab.tab)).toEqual([
      "user_machine",
      "user_mask",
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
    expect(mask.titleColumn).toBe("Suggested Title");
    expect(mask.urlColumn).toBe("Suggested URL");
  });

  it("addresses a tab by name, never by the gid the workbook can reassign", () => {
    const url = sheetValuesUrl("WORKBOOK", machine);

    expect(url).toContain("/v4/spreadsheets/WORKBOOK/values/");
    expect(url).toContain(encodeURIComponent("'user_machine'!A1:E"));
    expect(url).toContain("majorDimension=ROWS");
    expect(url).not.toContain("gid=");
  });

  it("pins the range to the width the allowlist declares", () => {
    // Asked for the whole tab, the API answers about whatever width the data
    // occupies. Asked for A1:E, a sixth column is a header the guard never
    // sees rather than a column that quietly joins the export.
    expect(sheetValuesUrl("WORKBOOK", machine)).toContain(
      encodeURIComponent("!A1:E")
    );
    expect(sheetValuesUrl("WORKBOOK", assignment)).toContain(
      encodeURIComponent("!A1:K")
    );
  });

  it("names each export after its tab, so the file says where it came from", () => {
    expect(EXPORT_TABS.map(exportFileName)).toEqual([
      "user_machine.csv",
      "user_mask.csv",
      "collection-assignment.csv",
    ]);
  });
});

describe("the Collection Assignment allowlist", () => {
  it("holds exactly the collection-assignment tab", () => {
    expect(ASSIGNMENT_TABS.map((tab) => tab.tab)).toEqual([
      "collection-assignment",
    ]);
  });

  it("carries the eleven columns of #26's locked schema, in order", () => {
    expect(assignment.headers).toEqual([
      "Field",
      "Legacy PNum(s)",
      "Legacy Text",
      "Base Name Source",
      "Profile Link Value",
      "Recommended Collection Title",
      "Recommended Collection URL",
      "Confidence",
      "Rationale",
      "Override",
      "Disposition",
    ]);
  });

  it("refuses a tab that is not the Collection Assignment, including an option table", () => {
    for (const forbidden of [
      "Discourse",
      "user-list-260410-001810",
      "collection_assignment",
      "user_machine",
    ]) {
      expect(() => assignmentTabNamed(forbidden)).toThrow(SheetExportError);
      expect(() => assignmentTabNamed(forbidden)).toThrow(
        /not in the allowlist/
      );
    }
  });

  it("keeps the two lookups apart, so neither returns the other's shape", () => {
    expect(() => tabNamed("collection-assignment")).toThrow(SheetExportError);
  });
});

describe("EXPORT_TABS", () => {
  it("is every tab the command fetches, option tables then assignment", () => {
    expect(EXPORT_TABS.map((tab) => tab.tab)).toEqual([
      "user_machine",
      "user_mask",
      "collection-assignment",
    ]);
  });

  it("says which of them contribute rows to the catalogue", () => {
    expect(EXPORT_TABS.map(sheetTabFor).map((tab) => tab?.tab ?? null)).toEqual(
      ["user_machine", "user_mask", null]
    );
  });

  it("hands back the allowlist entry, never the object it was asked about", () => {
    // The reason this returns a tab rather than answering yes about one. An
    // impostor carrying an allowlisted name would pass any `tab is SheetTab`
    // predicate and then be read as a row of empty strings, because the
    // `titleColumn` the narrowing promised is not there.
    const impostor = { tab: "user_machine", headers: ["Value"] };

    expect(sheetTabFor(impostor)).toBe(machine);
    expect(sheetTabFor(impostor)).not.toBe(impostor);
    expect(sheetTabFor({ ...noTitleTab, tab: "user_machine_" })).toBeNull();
  });

  it("addresses the Collection Assignment by name too", () => {
    const url = sheetValuesUrl("WORKBOOK", assignment);

    expect(url).toContain(encodeURIComponent("'collection-assignment'!A1:K"));
    expect(url).not.toContain("gid=");
  });
});

describe("readSheetTab", () => {
  it("accepts the real header row and returns only the data rows", () => {
    expect(readSheetTab(machine, MACHINE_CSV)).toHaveLength(2);
    expect(readSheetTab(mask, MASK_CSV)).toHaveLength(3);
  });

  it("accepts a tab whose third column header is blank", () => {
    expect(readSheetTab(noTitleTab, NO_TITLE_CSV)).toHaveLength(2);
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
    expect(() => readSheetTab(noTitleTab, NO_TITLE_CSV)).not.toThrow();
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
    expect(sheetRowsFrom(noTitleTab, NO_TITLE_CSV)).toEqual([]);
    expect(() => sheetRowsFrom(noTitleTab, MACHINE_CSV)).toThrow(
      /unexpected header row/
    );
  });
});

describe("readSheetTab, on the Collection Assignment", () => {
  // The Collection Assignment sits in the same workbook as the option tables and is
  // edited by hand rather than generated, so it gets the same three guards and
  // no weaker version of any of them.
  it("accepts the locked header row and returns only the data rows", () => {
    expect(readSheetTab(assignment, ASSIGNMENT_CSV)).toHaveLength(2);
  });

  it("aborts when a curator renames, adds or reorders a column", () => {
    const renamed = ASSIGNMENT_CSV.replace(`"Override"`, `"Curator Override"`);
    const added = ASSIGNMENT_CSV.replace(
      ASSIGNMENT_HEADER,
      `${ASSIGNMENT_HEADER},"Notes"`
    );
    const reordered = ASSIGNMENT_CSV.replace(
      `"Override","Disposition"`,
      `"Disposition","Override"`
    );

    for (const broken of [renamed, added, reordered]) {
      expect(() => readSheetTab(assignment, broken)).toThrow(SheetExportError);
      expect(() => readSheetTab(assignment, broken)).toThrow(
        /unexpected header row/
      );
    }
  });

  it("aborts on an empty response, which is how a renamed tab presents", () => {
    expect(() => readSheetTab(assignment, "")).toThrow(/renamed or removed/);
  });

  it("aborts when the tab has grown to a size it never reaches", () => {
    const row = new Array(assignment.headers.length).fill(`"x"`).join(",");
    const oversized = [
      ASSIGNMENT_HEADER,
      ...Array.from({ length: MAX_DATA_ROWS + 1 }, () => row),
    ].join("\n");

    expect(() => readSheetTab(assignment, oversized)).toThrow(/exceeds the/);
  });

  it("aborts when a cell holds something shaped like an email address", () => {
    // `Rationale` is free text a curator types, which makes it the likeliest
    // place in the workbook for a person's address to arrive by accident.
    const contaminated = ASSIGNMENT_CSV.replace(
      "A catch-all naming no one product.",
      "Confirmed by someone@example.com"
    );

    expect(() => readSheetTab(assignment, contaminated)).toThrow(
      /shaped like an email address/
    );
    expect(() => readSheetTab(assignment, contaminated)).toThrow(
      /^(?!.*someone@example\.com)/s
    );
  });
});

describe("assignmentRowsFrom", () => {
  it("names every column, and passes each value through verbatim", () => {
    expect(assignmentRowsFrom(assignment, ASSIGNMENT_CSV)[0]).toEqual({
      field: "Machine",
      legacyPnums: "6391",
      legacyText: "REFURB AirCurve 11 BiPAP ASV",
      baseNameSource: "Suggested Title",
      profileLinkValue: "AirCurve 11 BiPAP ASV (Discontinued)",
      recommendedCollectionTitle: "BiPAP Machines",
      recommendedCollectionUrl:
        "https://www.cpap.com/collections/bipap-machines",
      confidence: "High",
      rationale:
        "No active Shopify product; BiPAP is the nearest live collection.",
      override: "",
      disposition: "undecided",
    });
  });

  it("leaves an Override unapplied and a Disposition unjudged", () => {
    // Both are the transform's decisions (#37/#38). Resolving either here
    // would put a policy in the file whose whole job is to have none.
    const [, overridden] = assignmentRowsFrom(assignment, ASSIGNMENT_CSV);

    expect(overridden.recommendedCollectionUrl).toBe(
      "https://www.cpap.com/collections/full-face-cpap-masks"
    );
    expect(overridden.override).toBe(
      "https://www.cpap.com/collections/cpap-full-face-masks"
    );
    expect(overridden.disposition).toBe("collection");
  });

  it("keeps a comma inside Legacy PNum(s) as one field", () => {
    const [, multiple] = assignmentRowsFrom(assignment, ASSIGNMENT_CSV);

    expect(multiple.legacyPnums).toBe("5854, 5794");
  });

  it("reads by header, so it refuses the columns in a different order", () => {
    const reordered = ASSIGNMENT_CSV.replace(
      `"Confidence","Rationale"`,
      `"Rationale","Confidence"`
    );

    expect(() => assignmentRowsFrom(assignment, reordered)).toThrow(
      /unexpected header row/
    );
  });
});

describe("columnLetter", () => {
  it("names the column at a 1-based position", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(5)).toBe("E");
    expect(columnLetter(11)).toBe("K");
    expect(columnLetter(26)).toBe("Z");
  });

  it("keeps counting past the letter no tab here reaches", () => {
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(28)).toBe("AB");
    expect(columnLetter(52)).toBe("AZ");
    expect(columnLetter(53)).toBe("BA");
  });

  it("refuses a position that is not a column", () => {
    for (const nonsense of [0, -1, 1.5]) {
      expect(() => columnLetter(nonsense)).toThrow(SheetExportError);
    }
  });
});

describe("valuesToCsv", () => {
  // The API hands back JSON row arrays, so the committed bytes are
  // reconstructed rather than passed through. These are the properties that
  // make the reconstruction faithful.
  it("round-trips through parseCsv unchanged", () => {
    const values = parseCsv(MASK_CSV);

    expect(parseCsv(valuesToCsv(mask, values))).toEqual(values);
  });

  it("pads a row the API truncated back to the declared width", () => {
    // The API omits trailing empty cells, so a row with no Suggested URL comes
    // back short. Left ragged, a blank final column reads as a missing one.
    const truncated = [
      ["Value", "Text", "URL", "Suggested Title", "Suggested URL"],
      ["5854", "test10", "#N/A"],
    ];

    expect(parseCsv(valuesToCsv(mask, truncated))[1]).toEqual([
      "5854",
      "test10",
      "#N/A",
      "",
      "",
    ]);
  });

  it("quotes every field, the way the committed exports already look", () => {
    expect(valuesToCsv(noTitleTab, [["a", "b", "c"]])).toBe(`"a","b","c"`);
  });

  it("doubles a quote that a cell really holds", () => {
    const round = valuesToCsv(noTitleTab, [['6" hose', "b", "c"]]);

    expect(round).toBe(`"6"" hose","b","c"`);
    expect(parseCsv(round)[0][0]).toBe(`6" hose`);
  });

  it("keeps a comma and a newline that sit inside a cell", () => {
    const round = valuesToCsv(noTitleTab, [["a, b", "two\nlines", "c"]]);

    expect(parseCsv(round)[0]).toEqual(["a, b", "two\nlines", "c"]);
  });

  it("uses LF endings and emits no final newline", () => {
    const round = valuesToCsv(noTitleTab, [
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);

    expect(round).toBe(`"a","b","c"\n"d","e","f"`);
    expect(round).not.toContain("\r");
    expect(round.endsWith("\n")).toBe(false);
  });

  it("makes an empty tab present as the empty response readSheetTab refuses", () => {
    expect(valuesToCsv(mask, [])).toBe("");
    expect(() => readSheetTab(mask, valuesToCsv(mask, []))).toThrow(
      /renamed or removed/
    );
  });

  it("drops a column the tab never declared rather than exporting it", () => {
    // The range pins the width, so this should not arrive — but if it did,
    // exporting a twelfth column under an eleven-column header would put data
    // in `data/` that no guard ever looked at.
    const widened = [["a", "b", "c", "smuggled"]];

    expect(valuesToCsv(noTitleTab, widened)).toBe(`"a","b","c"`);
  });
});

describe("what each file is allowed to do", () => {
  // Read relative to the repository root, which is vitest's working directory.
  // `import.meta.url` would be the obvious way to resolve these and does not
  // typecheck here — the shared Discourse tsconfig builds to CommonJS output,
  // where the meta-property is not allowed.
  const lib = readFileSync("scripts/lib/sheet-export.ts", "utf8");
  const auth = readFileSync("scripts/lib/sheets-auth.ts", "utf8");
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
    for (const tab of EXPORT_TABS) {
      expect(command).not.toContain(tab.tab);
    }
    expect(command).not.toContain("gviz");
    expect(command).not.toContain("docs.google.com");
    expect(command).toContain("EXPORT_TABS");
  });

  it("keeps the credential out of the repository and out of every message", () => {
    // The private key is a bearer credential for everything the service
    // account can read. A refusal that quoted it would put it in a terminal
    // and a CI transcript, which are the repository's neighbours.
    expect(auth).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(auth).not.toMatch(/\bconsole\./);
    expect(auth).not.toMatch(/process\.std(out|err)/);
    expect(auth).not.toMatch(
      /\$\{\s*(privateKey|rawKey|credentials\.privateKey)/
    );
    expect(auth).not.toMatch(/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/);

    // Read from the environment it is handed, never from the ambient one, so
    // a test can hand it a fixture and the command owns where values come from.
    expect(auth).not.toContain("process.env");
  });

  it("asks for a read-only scope, named in one place", () => {
    expect(auth).toContain(
      "https://www.googleapis.com/auth/spreadsheets.readonly"
    );
    expect(auth).not.toContain('auth/spreadsheets"');
    expect(auth).not.toContain("auth/drive");
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
