// Global test setup.
//
// `Temporal.Now.instant()` / `Temporal.Instant.from()` are used by the server
// state DB, which Deno exposed as a built-in global but Node.js does not. Load
// the official polyfill so `Temporal` is available on the global object,
// exactly like it was under Deno.
import "temporal-polyfill/global";
