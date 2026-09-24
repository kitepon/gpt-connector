import { ConsultJobStore } from "../../src/consult-job-store.js";

const [stateDirectory, slug, mode] = process.argv.slice(2);
if (!stateDirectory || !slug || (mode !== "finish" && mode !== "exit")) {
  throw new Error("fixture arguments are invalid");
}

const store = new ConsultJobStore({ stateDirectory });
await store.initialize();
await store.reserve(slug, `fingerprint-${slug}`);
if (mode === "finish") {
  await store.transition(slug, "failed", {
    error: { code: "CHAT_FAILED", message: "fixture terminal", retry: "never" },
  });
  store.close();
}
