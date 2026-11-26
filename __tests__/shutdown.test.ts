import { jest } from "@jest/globals";
import express from "express";
import type { AddressInfo } from "net";
import {
  shutdown,
  closeHttpServer,
  registerShutdownHandlers,
  handleUncaughtException,
  type ShutdownDeps,
} from "../src/shutdown.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MockedDeps = ShutdownDeps & {
  stopPoller: jest.Mock;
  closeServer: jest.Mock;
  closeDb: jest.Mock;
  exit: jest.Mock;
};

function deps(overrides: Partial<ShutdownDeps> = {}): MockedDeps {
  return {
    stopPoller: jest.fn(),
    closeServer: jest.fn(async () => {}),
    closeDb: jest.fn(),
    exit: jest.fn(),
    timeoutMs: 5000,
    ...overrides,
  } as MockedDeps;
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

  it("waits for an async stopPoller before closing the DB (#870)", async () => {
    let releasePoll!: () => void;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const d = deps({ stopPoller: jest.fn(() => pollGate) });
    const pending = shutdown(d);
    await sleep(20);
    expect(d.closeServer).not.toHaveBeenCalled();
    expect(d.closeDb).not.toHaveBeenCalled();
    releasePoll();
    await pending;
    expect(d.closeDb).toHaveBeenCalledTimes(1);
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

describe("registerShutdownHandlers (#950)", () => {
  function register(overrides: Partial<ShutdownDeps> = {}) {
    const beforeTerm = process.listeners("SIGTERM") as Array<() => void>;
    const beforeInt = process.listeners("SIGINT") as Array<() => void>;
    registerShutdownHandlers({} as any, overrides);
    const sigterm = (process.listeners("SIGTERM") as Array<() => void>).find(
      (listener) => !beforeTerm.includes(listener)
    );
    const sigint = (process.listeners("SIGINT") as Array<() => void>).find(
      (listener) => !beforeInt.includes(listener)
    );
    if (!sigterm || !sigint) throw new Error("shutdown listeners were not registered");
    return {
      sigterm,
      sigint,
      cleanup: () => {
        process.off("SIGTERM", sigterm);
        process.off("SIGINT", sigint);
      },
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("drains on SIGTERM using injected dependencies", async () => {
    const d = deps();
    const { sigterm, cleanup } = register(d);
    try {
      sigterm();
      await jest.advanceTimersByTimeAsync(0);
      expect(d.stopPoller).toHaveBeenCalledTimes(1);
      expect(d.closeServer).toHaveBeenCalledTimes(1);
      expect(d.closeDb).toHaveBeenCalledTimes(1);
      expect(d.exit).toHaveBeenCalledWith(0);
    } finally {
      cleanup();
    }
  });

  it("ignores a second signal while shutting down", async () => {
    const d = deps();
    const { sigterm, cleanup } = register(d);
    try {
      sigterm();
      await jest.advanceTimersByTimeAsync(0);
      sigterm();
      await jest.advanceTimersByTimeAsync(0);
      expect(d.stopPoller).toHaveBeenCalledTimes(1);
      expect(d.exit).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("exits 1 when closeServer rejects", async () => {
    const d = deps({
      closeServer: jest.fn(async () => {
        throw new Error("close failed");
      }),
    });
    const { sigterm, cleanup } = register(d);
    try {
      sigterm();
      await jest.advanceTimersByTimeAsync(0);
      expect(d.exit).toHaveBeenCalledWith(1);
      expect(d.closeDb).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("force-exits 1 after timeoutMs when the drain never settles", async () => {
    const d = deps({
      timeoutMs: 1000,
      closeServer: jest.fn(() => new Promise<void>(() => {})),
    });
    const { sigterm, cleanup } = register(d);
    try {
      sigterm();
      await jest.advanceTimersByTimeAsync(999);
      expect(d.exit).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(d.exit).toHaveBeenCalledWith(1);
    } finally {
      cleanup();
    }
  });

  it("handles SIGINT as well as SIGTERM", async () => {
    const d = deps();
    const { sigint, cleanup } = register(d);
    try {
      sigint();
      await jest.advanceTimersByTimeAsync(0);
      expect(d.stopPoller).toHaveBeenCalledTimes(1);
      expect(d.exit).toHaveBeenCalledWith(0);
    } finally {
      cleanup();
    }
  });
});

describe("uncaughtException (#867)", () => {
  it("runs the graceful shutdown and exits 1", async () => {
    const d = deps();
    const before = {
      term: process.listeners("SIGTERM"),
      int: process.listeners("SIGINT"),
    };
    registerShutdownHandlers({} as any, d);
    try {
      handleUncaughtException(new Error("boom"), jest.fn());
      await sleep(0);
      expect(d.stopPoller).toHaveBeenCalledTimes(1);
      expect(d.closeServer).toHaveBeenCalledTimes(1);
      expect(d.closeDb).toHaveBeenCalledTimes(1);
      expect(d.exit).toHaveBeenCalledWith(1);
    } finally {
      for (const l of process.listeners("SIGTERM")) {
        if (!before.term.includes(l)) process.off("SIGTERM", l as () => void);
      }
      for (const l of process.listeners("SIGINT")) {
        if (!before.int.includes(l)) process.off("SIGINT", l as () => void);
      }
    }
  });
});
