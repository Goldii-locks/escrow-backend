/**
 * Opt-in Soroban E2E suite (#684). Needs Docker and a compiled escrow Wasm;
 * see CONTRIBUTING.md. Run with `npm run test:e2e`, never as part of `npm test`.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleFileExtensions: ["ts", "js"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }]
  },
  testMatch: ["<rootDir>/test/e2e/**/*.e2e-spec.ts"],
  testPathIgnorePatterns: ["/node_modules/"],
  globalSetup: "<rootDir>/test/e2e/global-setup.ts",
  globalTeardown: "<rootDir>/test/e2e/global-teardown.ts",
  // Network start-up happens in globalSetup; individual steps still wait on
  // ledger close and the indexer poller.
  testTimeout: 180000,
  maxWorkers: 1,
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1"
  }
};
