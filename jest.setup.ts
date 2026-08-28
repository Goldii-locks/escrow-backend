import { closeDb } from "./src/indexer/db.js";

// Release the SQLite handle after every suite. Without this, any test file
// that reaches indexer/db.ts leaves an open connection behind and Jest reports
// "A worker process has failed to exit gracefully".
afterAll(() => {
  closeDb();
});
