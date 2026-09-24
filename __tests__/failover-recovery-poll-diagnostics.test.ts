import { jest } from "@jest/globals";
import Database from "better-sqlite3";
import { setDb, runMigrations } from "../src/indexer/db.js";
import {
  initializeNodeHealthTables,
  logPollDiagnostics,
} from "../src/indexer/failover-recovery.js";
import logger from "../src/utils/logger.js";

describe("FailoverRecovery – poll diagnostics logging", () => {
  let testDb: Database.Database;

  beforeAll(() => {
    testDb = new Database(":memory:");
    setDb(testDb);
    runMigrations();
    initializeNodeHealthTables();
  });

  afterAll(() => {
    testDb.close();
  });

  it("logs a debug diagnostic string containing elapsed time and payload size", () => {
    const debugSpy = jest
      .spyOn(logger, "debug")
      .mockImplementation((() => logger) as never);

    const startedAt = Date.now() - 42;
    logPollDiagnostics("https://rpc.example.com", startedAt, 2048);

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = debugSpy.mock.calls[0] as unknown as [
      string,
      { nodeUrl: string; elapsedMs: number; payloadSizeBytes: number },
    ];
    expect(message).toEqual(expect.stringContaining("elapsedMs="));
    expect(message).toEqual(expect.stringContaining("payloadSizeBytes=2048"));
    expect(meta).toMatchObject({
      nodeUrl: "https://rpc.example.com",
      payloadSizeBytes: 2048,
    });
    expect(meta.elapsedMs).toBeGreaterThanOrEqual(0);

    debugSpy.mockRestore();
  });
});
