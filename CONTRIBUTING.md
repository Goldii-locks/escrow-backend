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
