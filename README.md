# Escrow Backend

Express + TypeScript backend for the Soroban milestone escrow platform.

## Tech Stack

- Node.js + Express
- TypeScript
- Stellar SDK
- Soroban RPC

## Table of Contents

- [Setup](#setup)
- [API Endpoints](#api-endpoints)
  - [GET /health](#get-health)
  - [GET /api/jobs/:contractid](#get-apijobss-contractid)
  - [POST /api/jobs/build-tx](#post-apijobsbuild-tx)
  - [POST /api/jobs/submit](#post-apijobssubmit)
- [Error Responses](#error-responses)
- [Related Repos](#related-repos)

## Setup

```bash
npm install
cp .env.example .env  # add your contract ID and deployer address
npm run dev
```

## API Endpoints

### GET /health

Check backend health.

#### Request

```bash
curl -X GET http://localhost:3000/health
```

#### Response

```json
{
  "status": "ok",
  "service": "escrow-backend"
}
```

### GET /api/jobs/:contractId

Get job state from the Soroban contract.

#### Request

```bash
curl -X GET http://localhost:3000/api/jobs/CBU3OHKZ2BHOHK5VMG3HBWIW3PBQHZLNMHNJUGM23W5NBFA75JMMWAVT
```

#### Response

```json
{
  "contractId": "CBU3OHKZ2BHOHK5VMG3HBWIW3PBQHZLNMHNJUGM23W5NBFA75JMMWAVT",
  "job": {
    "title": "Website redesign",
    "client": "G...",
    "freelancer": "G...",
    "amount": "100",
    "status": "funded"
  }
}
```

### POST /api/jobs/build-tx

Build an unsigned transaction for the frontend to sign.

#### Request

```bash
curl -X POST http://localhost:3000/api/jobs/build-tx \
  -H "Content-Type: application/json" \
  -d '{
    "contractId": "CBU3OHKZ2BHOHK5VMG3HBWIW3PBQHZLNMHNJUGM23W5NBFA75JMMWAVT",
    "operation": "fund_job",
    "args": {
      "jobId": "1",
      "amount": "100"
    },
    "sourceAccount": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }'
```

#### Response

```json
{
  "transactionXdr": "AAAAAgAAAA...",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "contractId": "CBU3OHKZ2BHOHK5VMG3HBWIW3PBQHZLNMHNJUGM23W5NBFA75JMMWAVT"
}
```

### POST /api/jobs/submit

Submit a signed transaction to the network.

#### Request

```bash
curl -X POST http://localhost:3000/api/jobs/submit \
  -H "Content-Type: application/json" \
  -d '{
    "transactionXdr": "AAAAAgAAAA...",
    "signature": "..."
  }'
```

#### Response

```json
{
  "status": "submitted",
  "hash": "7f1a7d7c9e7f9f9a2b...",
  "result": {
    "status": "success",
    "txStatus": "SUCCESS"
  }
}
```

## Error Responses

All endpoints return JSON errors in a consistent shape.

### Validation error

```json
{
  "error": "ValidationError",
  "message": "Invalid request body",
  "details": [
    {
      "field": "contractId",
      "message": "contractId is required"
    }
  ]
}
```

### Not found

```json
{
  "error": "NotFoundError",
  "message": "Job not found"
}
```

### Server error

```json
{
  "error": "InternalServerError",
  "message": "Something went wrong"
}
```

## Related Repos

- [escrow-contract](https://github.com/Goldii-locks/escrow-contract) — Soroban smart contract
- [escrow-frontend](https://github.com/Goldii-locks/escrow-frontend) — Next.js frontend
