// Global test setup.
//
// `Temporal.Now.instant()` / `Temporal.Instant.from()` are used by the server
// state DB, but Node.js doesn't expose `Temporal` as a global. Load the
// official polyfill so it's available on the global object.
import "temporal-polyfill/global";
