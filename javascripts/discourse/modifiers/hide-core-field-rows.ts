import { modifier } from "ember-modifier";
import { dasherize } from "@ember/string";
import { coreRowsToHide } from "../lib/core-field-rows";

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

export default modifier(
  (
    element: HTMLElement,
    [scopeSelector, fieldNames]: [string, readonly string[]]
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

    const hidden = coreRowsToHide(rows, fieldNames.map(dasherize));

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
