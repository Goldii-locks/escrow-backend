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

## End-to-End Tests (Soroban quickstart)

`npm test` runs the unit suites under `__tests__/` with RPC mocked. A separate,
opt-in suite under `test/e2e/` runs the real backend against a local Stellar
network with the escrow contract deployed, covering
`create-job-draft` → `build-tx initialize` → sign → `submit` → indexer poll →
`GET /api/jobs/by-wallet/:address` → `GET /api/jobs/:contractId`.
It runs nightly in CI ([e2e-nightly.yml](./.github/workflows/e2e-nightly.yml))
and can be started manually from the Actions tab.

Prerequisites:

- Docker, with port `8000` free
- The compiled escrow contract Wasm. Clone
  [escrow-contract](https://github.com/Goldii-locks/escrow-contract) next to
  this repo and build it:
  ```bash
  cd ../escrow-contract
  cargo build --release --target wasm32v1-none -p milestone-escrow
  ```

Run it:

```bash
npm run test:e2e
```

The suite starts `stellar/quickstart --local --enable-soroban-rpc` in Docker
(or reuses one already answering on `E2E_RPC_URL`), deploys the Wasm and the
native XLM token contract, then spawns the backend on port `3101` with a
throwaway SQLite database. A container the suite started is stopped
afterwards.

Optional overrides:

| Variable | Default |
|---|---|
| `ESCROW_WASM_PATH` | `../escrow-contract/target/wasm32v1-none/release/milestone_escrow.wasm` |
| `E2E_RPC_URL` | `http://localhost:8000/soroban/rpc` |
| `E2E_FRIENDBOT_URL` | `http://localhost:8000/friendbot` |
| `E2E_NETWORK_PASSPHRASE` | `Standalone Network ; February 2017` |
| `E2E_BACKEND_PORT` | `3101` |
| `E2E_DOCKER_CONTAINER` | `escrow-backend-e2e-quickstart` |
| `E2E_QUICKSTART_IMAGE` | `stellar/quickstart:latest` |
| `E2E_KEEP_NETWORK` | unset; `1` leaves the container running for debugging |

## Code Style

Follow the project's existing code style and use ESLint to check:
```bash
npm run lint
```

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
