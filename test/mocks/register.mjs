// Registers the module-resolution loader before the test module loads.
// Used via:  node --import ./test/mocks/register.mjs ./test/run-sheet.test.mjs
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
