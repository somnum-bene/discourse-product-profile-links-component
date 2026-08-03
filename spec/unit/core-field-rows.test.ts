import { describe, expect, it } from "vitest";
import {
  coreRowsToHide,
  usableDasherizedNames,
} from "../../javascripts/discourse/lib/core-field-rows";

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

describe("usableDasherizedNames", () => {
  it("keeps a name that identifies one Custom User Field", () => {
    expect(usableDasherizedNames(["machine"], ["machine", "mask"])).toEqual([
      "machine",
    ]);
  });

  it("drops a name two Custom User Fields dasherize onto", () => {
    // "Sleep Apnea" and "sleep-apnea" are two fields core tags identically.
    expect(
      usableDasherizedNames(
        ["sleep-apnea"],
        ["sleep-apnea", "sleep-apnea", "mask"]
      )
    ).toEqual([]);
  });

  it("drops only the ambiguous name, not the rest", () => {
    expect(
      usableDasherizedNames(
        ["machine", "sleep-apnea"],
        ["machine", "sleep-apnea", "sleep-apnea"]
      )
    ).toEqual(["machine"]);
  });

  it("keeps everything when the site has no colliding field names", () => {
    expect(
      usableDasherizedNames(["machine", "mask"], ["machine", "mask", "tubing"])
    ).toEqual(["machine", "mask"]);
  });

  it("drops a name that dasherizes onto the class core puts on every row", () => {
    // A Custom User Field named "Public User Field". Absurd, but it would match
    // every row on the page, so it is refused even though nothing collides.
    expect(
      usableDasherizedNames(
        ["public-user-field"],
        ["public-user-field", "mask"]
      )
    ).toEqual([]);
  });

  it("drops a blank name, which identifies no field at all", () => {
    expect(usableDasherizedNames([""], ["machine"])).toEqual([]);
  });

  it("leaves a name alone when the site list is empty", () => {
    // Nothing is known to collide with it, so there is nothing to protect.
    expect(usableDasherizedNames(["machine"], [])).toEqual(["machine"]);
  });

  it("hides nothing once an ambiguous name reaches coreRowsToHide", () => {
    const rows = [
      { classNames: ["public-user-field", "sleep-apnea"] },
      { classNames: ["public-user-field", "mask"] },
    ];
    const safe = usableDasherizedNames(
      ["sleep-apnea"],
      ["sleep-apnea", "sleep-apnea"]
    );

    expect(coreRowsToHide(rows, safe)).toEqual([]);
  });
});
