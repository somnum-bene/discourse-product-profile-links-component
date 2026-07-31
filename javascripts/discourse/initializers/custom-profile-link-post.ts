import { withPluginApi } from "discourse/lib/plugin-api";
import CustomProfileLinkPost from "../components/custom-profile-link-post";

export default {
  name: "custom-profile-link-post",
  initialize() {
    withPluginApi((api) => {
      api.renderAfterWrapperOutlet(
        "post-content-cooked-html",
        CustomProfileLinkPost
      );
    });
  },
};
