# Contributing to Milestone Escrow Backend

Thank you for your interest in contributing! This document outlines the process for making contributions.

## Getting Started

1. Fork the repository on GitHub
2. Clone your forked repo locally
3. Install dependencies: `npm install`
4. Copy .env.example to .env and fill in the required values
5. Run the development server: `npm run dev`

## Making Changes

1. Create a new branch for your feature/fix: `git checkout -b my-feature`
2. Make your changes to the codebase
3. Write tests for new functionality (if applicable)
4. Verify the app runs correctly: `npm run dev`
5. Ensure the code builds: `npm run build`

Before changing runtime behavior, review:

- [Architecture overview](./docs/ARCHITECTURE.md)
- [CSV serialization guide](./docs/CSV_SERIALIZATION_GUIDE.md)

## Logging Policy

### Wallet address privacy

Full Stellar G-addresses (56-character public keys) **must not appear in `info`-level log lines**.

The production log level is `info` (`LOG_LEVEL=info`). The HTTP request logger in
`src/index.ts` already records the caller's IP on every request, so logging a full address
at `info` alongside it builds a durable IP↔wallet map — more than the service needs to
operate.

Rules:
- Use `maskAddress(addr)` (exported from `src/routes/jobs.ts`) at `info` level.
  It produces `GABC…WXYZ` — enough for same-session correlation without exposing the full key.
- If you need the full address for debugging, log it at `debug`:
  ```ts
  logger.info("Doing thing",  { address: maskAddress(address) });
  logger.debug("Doing thing (full address)", { address });
  ```
- Contract IDs and counts are safe at `info`; they identify the contract, not the person.
- The indexer (`src/indexer/poller.ts`) follows the same rule: only byte counts appear in
  diagnostics, never payload contents.

This policy is enforced by `__tests__/address-logging-privacy.test.ts`, which asserts
that no full G-address appears in `info`-level output for the by-wallet, create-job-draft,
and job-fetch endpoints.
## Testing & Coverage

Run tests locally:
```bash
npm test
```

To run with coverage checking:
```bash
npm test -- --coverage
```

The CI suite enforces global test coverage thresholds in `jest.config.js`:
- **Lines**: 85%
- **Branches**: 75%

Pull requests that cause global coverage to drop below these thresholds will fail the CI build.

## End-to-End Tests (Soroban quickstart)

`npm test` runs the unit suites under `__tests__/` with RPC mocked. A separate,
opt-in suite under `test/e2e/` runs the real backend against a local Stellar
network with the escrow contract deployed, covering `create-job-draft` →
indexer backfill of the constructor's `init` event →
`GET /api/jobs/by-wallet/:address` → `GET /api/jobs/:contractId` →
`build-tx fund` → sign → `submit` → `GET /api/jobs/:contractId` (funded).
It runs nightly in CI ([e2e-nightly.yml](./.github/workflows/e2e-nightly.yml))
and can be started manually from the Actions tab.

Prerequisites:

- Docker, with port `8000` free
- The compiled escrow contract Wasm. Clone
  [escrow-contract](https://github.com/Goldii-locks/escrow-contract) next to
  this repo and build it with [stellar-cli](https://github.com/stellar/stellar-cli)
  (soroban-sdk refuses a plain `cargo build`):
  ```bash
  cd ../escrow-contract
  stellar contract build --manifest-path contracts/milestone-escrow/Cargo.toml
  ```

Run it:

```bash
npm run test:e2e
```

The suite starts `stellar/quickstart --local --enable-soroban-rpc --limits
unlimited` in Docker (or reuses one already answering on `E2E_RPC_URL`),
deploys the native XLM token contract and the escrow Wasm with its
constructor arguments, has the freelancer and arbiter accept the job, then
spawns the backend on port `3101` with a throwaway SQLite database. A
container the suite started is stopped afterwards.

Optional overrides:

| Variable | Default |
|---|---|
| `ESCROW_WASM_PATH` | `../escrow-contract/target/wasm32v1-none/release/milestone_escrow.wasm` |
| `E2E_RPC_URL` | `http://localhost:8000/soroban/rpc` |
| `E2E_FRIENDBOT_URL` | `http://localhost:8000/friendbot` |
| `E2E_NETWORK_PASSPHRASE` | `Standalone Network ; February 2017` |
| `E2E_BACKEND_PORT` | `3101` |
| `E2E_DOCKER_CONTAINER` | `escrow-backend-e2e-quickstart` |
| `E2E_QUICKSTART_IMAGE` | `stellar/quickstart:v678-b1525.1-latest` (the tag escrow-contract's E2E pins) |
| `E2E_KEEP_NETWORK` | unset; `1` leaves the container running for debugging |

## Code Style

Follow the project's existing code style and use ESLint to check:
```bash
npm run lint
```

CI enforces an ESLint warning ratchet (`--max-warnings=95`). New warnings or unused variables will fail the build. As debt and unused variables are cleaned up across the codebase, this limit is ratcheted downward toward zero.

## Submitting Changes

1. Commit your changes with a clear, descriptive message: `git commit -m "feat: add XYZ functionality"`
2. Push your branch to your fork: `git push origin my-feature`
3. Open a pull request (PR) on the main repository
4. Your PR will be reviewed and merged after approval

## Reporting Issues

If you find a bug or have a feature request, please open an issue on GitHub with clear details:
- Steps to reproduce the problem (if bug)
- Expected behavior
- Actual behavior
- System information (Node version, OS, etc.)

## Code of Conduct

We expect all contributors to be respectful and inclusive in their interactions.
