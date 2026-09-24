import { closeDb } from "./src/indexer/db.js";
import { TEST_API_KEY } from "./__tests__/helpers/api-key-helper.js";

// The job routes' API-key gate fails closed: an unset API_KEY rejects the
// request rather than waving it through. Give every suite a configured key by
// default so tests whose subject is not authentication still reach their
// handlers; auth suites override this in their own beforeEach.
beforeEach(() => {
  process.env.API_KEY = TEST_API_KEY;
});

// Release the SQLite handle after every suite. Without this, any test file
// that reaches indexer/db.ts leaves an open connection behind and Jest reports
// "A worker process has failed to exit gracefully".
afterAll(() => {
  closeDb();
});
