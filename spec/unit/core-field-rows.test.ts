import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  coreRowsToHide,
  replacedFieldNames,
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

describe("replacedFieldNames", () => {
  function link(fieldName: string, valueFieldName: string) {
    return {
      fieldName,
      valueFieldName,
      value: "AirSense 11",
      url: "https://example.com/airsense-11",
    };
  }

  it("names the Managed Field when the value came from it", () => {
    expect(replacedFieldNames([link("Machine", "Machine")])).toEqual([
      "Machine",
    ]);
  });

  it("names the Shadow Field when the fallback fired", () => {
    // The row core rendered belongs to the field holding the value. Under a
    // fallback the Managed Field is empty, so it has no row to hide, and
    // matching on the link's label would leave the Shadow Field's plain text
    // sitting under the Profile Link that replaced it.
    expect(
      replacedFieldNames([link("Machine", "Machine (Discontinued)")])
    ).toEqual(["Machine (Discontinued)"]);
  });

  it("never names the Managed Field and its Shadow Field for one link", () => {
    // One link replaces one row. Naming both would hide a row belonging to a
    // field whose value is not on screen.
    expect(
      replacedFieldNames([link("Machine", "Machine (Discontinued)")])
    ).not.toContain("Machine");
  });

  it("leaves a Shadow Field's row alone when the Managed Field won", () => {
    // Both populated and disagreeing: the Managed Field wins the link, and the
    // Shadow Field's row is a second value with no link behind it. Hiding it
    // would take a value off the profile, which this module refuses to do.
    expect(replacedFieldNames([link("Machine", "Machine")])).not.toContain(
      "Machine (Discontinued)"
    );
  });

  it("names one field per link, in the order the links render", () => {
    expect(
      replacedFieldNames([
        link("Machine", "Machine (Discontinued)"),
        link("Mask", "Mask"),
      ])
    ).toEqual(["Machine (Discontinued)", "Mask"]);
  });

  it("returns an empty list when nothing resolved", () => {
    expect(replacedFieldNames([])).toEqual([]);
  });

  it("hands names the row matcher can use unchanged", () => {
    // The end-to-end shape, because the two halves are only useful together:
    // a Shadow Field's name carries spaces and parentheses, and it has to
    // survive dasherizing into a class core actually emits. `dasherize` maps
    // " " to "-" and leaves the parentheses, on both surfaces' spellings.
    const names = replacedFieldNames([
      link("Machine", "Machine (Discontinued)"),
    ]);
    const dasherized = names.map((name) =>
      name.toLowerCase().replace(/[ _]/g, "-")
    );

    expect(dasherized).toEqual(["machine-(discontinued)"]);

    const profile = profileRow("machine-(discontinued)");
    const card = cardRow("machine-(discontinued)");

    expect(coreRowsToHide([profile, card], dasherized)).toEqual([
      profile,
      card,
    ]);
  });

  it("keeps a Shadow Field name distinguishable from the field it shadows", () => {
    // `usableDasherizedNames` drops a name two Custom User Fields share after
    // dasherizing. "Machine" and "Machine (Discontinued)" must not collide, or
    // the fallback's duplicate could never be hidden on any site running both.
    const site = ["Machine", "Mask", "Machine (Discontinued)"].map((name) =>
      name.toLowerCase().replace(/[ _]/g, "-")
    );

    expect(usableDasherizedNames(["machine-(discontinued)"], site)).toEqual([
      "machine-(discontinued)",
    ]);
  });
});

describe("the Link Surfaces answer this question the same way", () => {
  // ADR-0004 keeps the user card and the user profile as separate components
  // with separate wrappers, deliberately, and that duplication has a cost this
  // pins: a change made to one surface and forgotten on the other. It is the
  // exact failure mode the Shadow Field fallback invites, because the symptom
  // is a duplicated value on one surface only — visible to a User, invisible
  // to every test that does not render a page.
  //
  // Read as source rather than rendered, because a Glimmer component needs a
  // running Discourse and these tests deliberately need nothing (ADR-0003).
  // The precedent is `lint-gates.test.ts`, which reads the files that define
  // the gates for the same reason.
  const SURFACES = [
    "javascripts/discourse/connectors/user-profile-primary/custom-profile-link.gts",
    "javascripts/discourse/connectors/user-card-metadata/custom-profile-link.gts",
  ];

  // The third Link Surface (ADR-0004). It needed no change, and that is the
  // finding rather than an omission: a post carries no core Custom User Field
  // rows, so there is no duplicate to hide and nothing for the rule above to
  // do there. It still gets the fallback, through the same `profileLinksFor`
  // the other two call, and labels it with the Managed Field's name like they
  // do.
  //
  // Pinned because the obvious "make it consistent" change is to give it the
  // hiding the other two have, and on a post that would search a whole topic
  // for rows that do not exist and hide whatever it turned up.
  const POST_SURFACE =
    "javascripts/discourse/components/custom-profile-link-post.gts";

  it(`${POST_SURFACE} inherits the fallback and hides no core row`, () => {
    const source = readFileSync(POST_SURFACE, "utf8");

    expect(source).toContain("profileLinksFor(this.site, userFields)");
    expect(source).not.toContain("replacedFieldNames");
    expect(source).not.toContain("hideCoreFieldRows");
  });

  for (const surface of SURFACES) {
    const source = readFileSync(surface, "utf8");

    it(`${surface} derives its replaced rows from the shared rule`, () => {
      expect(source).toContain(
        'import { replacedFieldNames } from "../../lib/core-field-rows"'
      );
      expect(source).toContain("return replacedFieldNames(this.links);");
    });

    it(`${surface} does not decide it from the link's label`, () => {
      // The pre-fallback spelling. It reads as correct and is wrong for
      // exactly one case, so it has to be named to stay gone.
      expect(source).not.toContain("this.links.map((link) => link.fieldName)");
    });
  }
});
