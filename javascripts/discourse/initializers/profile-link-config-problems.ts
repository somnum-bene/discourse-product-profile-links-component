import { withPluginApi } from "discourse/lib/plugin-api";
import { reportConfigProblems } from "../lib/profile-links-config";
import type { SiteLike } from "../lib/profile-links-config";

// Reports Config Problems at boot rather than when a Link Surface renders, so
// an administrator sees them on any page — including the theme settings page
// they were just editing, which renders no Link Surface at all.
export default {
  name: "profile-link-config-problems",
  initialize() {
    withPluginApi((api) => {
      reportConfigProblems(api.container.lookup("service:site") as SiteLike);
    });
  },
};
