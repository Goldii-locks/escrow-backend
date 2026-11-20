#!/usr/bin/env node
/**
 * Minimal Soroban JSON-RPC stand-in for the load test (#965).
 *
 * Answers just enough for the backend to boot, pass /ready and serve the
 * public read endpoints: getNetwork, getHealth, getLatestLedger, getEvents
 * (always empty) and simulateTransaction (a fixed `get_job` result, `false`
 * for is_paused, one token for get_whitelisted_tokens). Every simulation
 * waits MOCK_RPC_LATENCY_MS to stand in for a real RPC round trip.
 *
 * GET /stats returns per-method call counts, which is how the runner tells
 * cache hits from RPC calls on GET /api/jobs/:contractId.
 *
 *   node loadtest/mock-rpc.mjs
 */
import http from "node:http";
import {
  Address,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

const PORT = Number(process.env.MOCK_RPC_PORT ?? 8100);
const LATENCY_MS = Number(process.env.MOCK_RPC_LATENCY_MS ?? 50);
const PASSPHRASE = process.env.SOROBAN_NETWORK_PASSPHRASE ?? "Standalone Network ; February 2017";
// Start above any seeded ledger and close one every 5 s like a real network.
const START_LEDGER = Number(process.env.MOCK_RPC_START_LEDGER ?? 10_000_000);
const startedAt = Date.now();
const latestLedger = () => START_LEDGER + Math.floor((Date.now() - startedAt) / 5000);

const counts = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sym = (s) => xdr.ScVal.scvSymbol(s);
const entry = (key, val) => new xdr.ScMapEntry({ key: sym(key), val });
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const account = (i) => new Address(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, i))).toScVal();
const contract = (i) => new Address(StrKey.encodeContract(Buffer.alloc(32, i))).toScVal();

const milestone = (amount) =>
  xdr.ScVal.scvMap([entry("amount", i128(amount)), entry("status", xdr.ScVal.scvVec([sym("Pending")]))]);

/** The contract's Job struct: an scvMap with sorted keys. */
const JOB = xdr.ScVal.scvMap([
  entry("arbiter", account(3)),
  entry("client", account(1)),
  entry("freelancer", account(2)),
  entry("funded", i128(3500)),
  entry("milestones", xdr.ScVal.scvVec([milestone(1000), milestone(2500)])),
  entry("token", contract(9)),
]);

const RETVALS = {
  get_job: JOB,
  is_paused: xdr.ScVal.scvBool(false),
  get_whitelisted_tokens: xdr.ScVal.scvVec([contract(9)]),
};

const TX_DATA = new SorobanDataBuilder().build().toXDR("base64");

function invokedFunction(transactionXdr) {
  try {
    const tx = TransactionBuilder.fromXDR(transactionXdr, PASSPHRASE);
    const op = tx.operations[0];
    if (op?.type !== "invokeHostFunction") return undefined;
    return op.func.invokeContract().functionName().toString();
  } catch {
    return undefined;
  }
}

const handlers = {
  getHealth: () => ({
    status: "healthy",
    latestLedger: latestLedger(),
    oldestLedger: 1,
    ledgerRetentionWindow: 17280,
  }),
  getNetwork: () => ({ passphrase: PASSPHRASE, protocolVersion: 22 }),
  getLatestLedger: () => ({ id: "0".repeat(64), protocolVersion: 22, sequence: latestLedger() }),
  getEvents: () => {
    const latest = latestLedger();
    const now = Math.floor(Date.now() / 1000);
    return {
      events: [],
      cursor: String(latest),
      latestLedger: latest,
      oldestLedger: 1,
      latestLedgerCloseTime: String(now),
      oldestLedgerCloseTime: String(now - latest * 5),
    };
  },
  simulateTransaction: async (params) => {
    await sleep(LATENCY_MS);
    const fn = invokedFunction(params?.transaction);
    if (fn) counts[`simulateTransaction:${fn}`] = (counts[`simulateTransaction:${fn}`] ?? 0) + 1;
    const retval = RETVALS[fn] ?? xdr.ScVal.scvVoid();
    return {
      latestLedger: latestLedger(),
      minResourceFee: "100",
      results: [{ auth: [], xdr: retval.toXDR("base64") }],
      transactionData: TX_DATA,
    };
  },
};

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    let id = null;
    let payload;
    try {
      const rpc = JSON.parse(body);
      id = rpc.id ?? null;
      counts[rpc.method] = (counts[rpc.method] ?? 0) + 1;
      const handler = handlers[rpc.method];
      payload = handler
        ? { jsonrpc: "2.0", id, result: await handler(rpc.params) }
        : { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${rpc.method}` } };
    } catch (err) {
      payload = { jsonrpc: "2.0", id, error: { code: -32603, message: String(err) } };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock Soroban RPC on http://127.0.0.1:${PORT} (simulate latency ${LATENCY_MS} ms)`);
});
