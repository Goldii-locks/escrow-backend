# Escrow Backend

Express + TypeScript backend for the Soroban milestone escrow platform.

## Tech Stack

- Node.js + Express
- TypeScript
- Stellar SDK
- Soroban RPC

## Setup

```bash
npm install
cp .env.example .env  # add your contract ID and deployer address
npm run dev
```

## API Endpoints

- `GET /health` - Check backend health
- `GET /api/jobs/:contractId` - Get job state from contract
- `POST /api/jobs/build-tx` - Build unsigned transaction for frontend to sign
- `POST /api/jobs/submit` - Submit signed transaction to network

## Related Repos

- https://github.com/Goldii-locks/escrow-contract — Soroban smart contract
- https://github.com/Goldii-locks/escrow-frontend — Next.js frontend
