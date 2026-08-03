import { describe, expect, it } from "vitest";
import { coreRowsToHide } from "../../javascripts/discourse/lib/core-field-rows";

/** A row as core renders it on the user profile: the bare dasherized name. */
function profileRow(dasherizedName: string) {
  return { classNames: ["public-user-field", dasherizedName] };
}

/** A row as core renders it on the user card: the name, prefixed. */
function cardRow(dasherizedName: string) {
  return {
    classNames: ["public-user-field", `public-user-field__${dasherizedName}`],
  };
}

describe("coreRowsToHide", () => {
  it("hides a profile row whose field has a Profile Link", () => {
    const machine = profileRow("machine");

    expect(coreRowsToHide([machine], ["machine"])).toEqual([machine]);
  });

  it("hides a user card row, which core spells differently", () => {
    const machine = cardRow("machine");

    expect(coreRowsToHide([machine], ["machine"])).toEqual([machine]);
  });

  it("leaves a field with no Profile Link alone", () => {
    const rows = [profileRow("machine"), profileRow("mask")];

    expect(coreRowsToHide(rows, ["machine"])).toEqual([rows[0]]);
  });

  it("hides every field that has a Profile Link", () => {
    const rows = [profileRow("machine"), profileRow("mask"), cardRow("tubing")];

    expect(coreRowsToHide(rows, ["machine", "tubing"])).toEqual([
      rows[0],
      rows[2],
    ]);
  });

  it("hides nothing when no Profile Link resolved", () => {
    const rows = [profileRow("machine"), cardRow("mask")];

    expect(coreRowsToHide(rows, [])).toEqual([]);
  });

  it("hides nothing on a row core tagged with no field name", () => {
    const untagged = { classNames: ["public-user-field"] };

    expect(coreRowsToHide([untagged], ["machine"])).toEqual([]);
  });

  it("never hides every row because a name dasherized onto core's own class", () => {
    const rows = [profileRow("machine"), cardRow("mask")];

    expect(coreRowsToHide(rows, ["public-user-field"])).toEqual([]);
  });

  it("ignores a blank field name rather than matching on it", () => {
    const rows = [profileRow("machine"), { classNames: ["public-user-field"] }];

    expect(coreRowsToHide(rows, [""])).toEqual([]);
  });

  it("matches on the dasherized name only, never the raw field name", () => {
    const rows = [profileRow("sleep-apnea-machine")];

    // The modifier dasherizes before calling in. Passing a raw name is a caller
    // bug, and it must fail visibly as "nothing hidden" rather than by chance.
    expect(coreRowsToHide(rows, ["Sleep Apnea Machine"])).toEqual([]);
    expect(coreRowsToHide(rows, ["sleep-apnea-machine"])).toEqual(rows);
  });
});
