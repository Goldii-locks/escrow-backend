import express from "express";
import type { AddressInfo } from "net";
import {
  shutdown,
  closeHttpServer,
  type ShutdownDeps,
} from "../src/shutdown.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & {
  stopPoller: jest.Mock;
  closeServer: jest.Mock;
  closeDb: jest.Mock;
  exit: jest.Mock;
} {
  return {
    stopPoller: jest.fn(),
    closeServer: jest.fn(async () => {}),
    closeDb: jest.fn(),
    exit: jest.fn(),
    timeoutMs: 5000,
    ...overrides,
  };
}

describe("graceful shutdown (#623)", () => {
  it("runs stopPoller → server.close → closeDb → exit(0) in order", async () => {
    const d = deps();
    await shutdown(d);
    const order = [
      d.stopPoller.mock.invocationCallOrder[0],
      d.closeServer.mock.invocationCallOrder[0],
      d.closeDb.mock.invocationCallOrder[0],
      d.exit.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("waits for server.close before closing the DB", async () => {
    let releaseServer!: () => void;
    const serverGate = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    const d = deps({ closeServer: jest.fn(() => serverGate) });
    const pending = shutdown(d);
    await sleep(20);
    expect(d.closeDb).not.toHaveBeenCalled();
    releaseServer();
    await pending;
    expect(d.closeDb).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("an in-flight request completes when shutdown drains the server", async () => {
    const app = express();
    app.get("/slow", async (_req, res) => {
      await sleep(200);
      res.json({ ok: true });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const responsePromise = fetch(`http://127.0.0.1:${port}/slow`);
    await sleep(50); // ensure the request is in flight

    const d = deps({ closeServer: closeHttpServer(server) });
    await shutdown(d);

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(d.closeDb).toHaveBeenCalledTimes(1);
    expect(d.exit).toHaveBeenCalledWith(0);
  });
});
