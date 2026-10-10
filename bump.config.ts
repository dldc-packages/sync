import { defineConfig } from "bumpp";

export default defineConfig({
  commit: "chore: release {tag}",
  tag: "v{version}", // must match the publish workflow's tag trigger (v*)
});
