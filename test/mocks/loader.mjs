// Module resolution hook: redirect every import of "@slack/bolt" to the local
// offline mock so app.js registers its handlers against a fake App instead of
// connecting to Slack. Registered via register.mjs (node --import).
import { fileURLToPath } from "node:url";

const MOCK_URL = new URL("./slack-bolt.mock.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@slack/bolt") {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

// Exported so the test can import the exact same mock-module URL and therefore
// share the singleton `registry`.
export const MOCK_PATH = fileURLToPath(MOCK_URL);
