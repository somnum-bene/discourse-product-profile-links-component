import type { ThemeSettings } from "../javascripts/discourse/lib/profile-links";

// Discourse exposes a theme's settings.yml to its JavaScript as an ambient
// global. This declaration is the only place that global is described; it lives
// outside javascripts/ so Discourse does not ingest it as a theme asset.
declare global {
  const settings: ThemeSettings & {
    profile_link_debug_mode: boolean;
  };
}

export {};
