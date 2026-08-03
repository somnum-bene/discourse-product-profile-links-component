import { dasherize } from "@ember/string";
import { modifier } from "ember-modifier";
import { coreRowsToHide, usableDasherizedNames } from "../lib/core-field-rows";

// The seam between the row-matching rule and the page. This is the only place
// that reaches outside the component's own DOM, so a Discourse change that
// breaks the duplicate-hiding breaks it here and nowhere else.
//
// Core's markup is depended on in exactly three ways, all of them here:
//
//   1. `scopeSelector` — an ancestor shared by our Link Surface and core's
//      rows. `.primary-textual` on the user profile, `.card-content` on the
//      user card. Scoping to it keeps the search off the rest of the page.
//   2. `.public-user-field` — the class on each of core's rows.
//   3. `dasherize` — core tags each row with the field name run through
//      Ember's `dasherize`, so the same function is used here rather than
//      reimplemented, and the two cannot drift.
//
// If core stops emitting any of these, the duplicate comes back and nothing
// else breaks: the Profile Links still render, they just sit under core's plain
// text again, which is how the component behaved before this existed.

/** Hides one of core's rows. `common/common.scss` gives it `display: none`. */
const HIDDEN_CLASS = "custom-profile-link-replaced";

/** Names already reported, so the warning is not repeated on every render. */
const reportedUnusable = new Set<string>();

function reportUnusable(fieldName: string) {
  if (reportedUnusable.has(fieldName)) {
    return;
  }
  reportedUnusable.add(fieldName);

  // eslint-disable-next-line no-console
  console.warn(
    `[Profile Links] The Custom User Field "${fieldName}" cannot be told apart from another field in Discourse's markup, because both dasherize to the same class name. The Profile Link is shown, but Discourse's plain-text row is left in place rather than risk hiding the wrong field's value. Renaming one of the fields resolves this.`
  );
}

export default modifier(
  (
    element: HTMLElement,
    [scopeSelector, fieldNames, siteFieldNames]: [
      string,
      readonly string[],
      readonly string[],
    ]
  ) => {
    const scope = element.closest(scopeSelector);
    if (!scope) {
      return;
    }

    const rows = Array.from(scope.querySelectorAll(".public-user-field"))
      // Our own rows carry core's class so they inherit core's styling. They
      // are never core's, so they are never candidates for hiding.
      .filter((row) => !element.contains(row))
      .map((row) => ({ row, classNames: Array.from(row.classList) }));

    // Dasherizing here, with the same function core uses, is what keeps the two
    // in step. It is also lossy, so anything it makes ambiguous is dropped
    // before it can hide a row belonging to a different Custom User Field.
    const safeNames = usableDasherizedNames(
      fieldNames.map(dasherize),
      siteFieldNames.map(dasherize)
    );

    // A dropped name means a duplicate the admin can see but not explain, so it
    // is worth a word in the console. Warning per field name rather than per
    // dropped row keeps it to once, however many profiles are visited.
    for (const fieldName of fieldNames) {
      if (!safeNames.includes(dasherize(fieldName))) {
        reportUnusable(fieldName);
      }
    }

    const hidden = coreRowsToHide(rows, safeNames);

    for (const { row } of hidden) {
      row.classList.add(HIDDEN_CLASS);
    }

    // Runs before the modifier re-runs and when the element goes away. Without
    // it a user card, whose DOM is reused from one user to the next, would keep
    // hiding a row for a user whose value has no Profile Link.
    return () => {
      for (const { row } of hidden) {
        row.classList.remove(HIDDEN_CLASS);
      }
    };
  }
);
