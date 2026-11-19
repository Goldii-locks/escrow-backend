import { jest } from "@jest/globals";
import express from "express";
import type { Server } from "http";
import { main } from "../src/index.js";

function fakeServer(): Server {
  return { close: jest.fn() } as unknown as Server;
}

describe("startup sequence (#950)", () => {
  it("validates the network, starts the indexer and binds the port on success", async () => {
    const order: string[] = [];
    const runMigrations = jest.fn(() => order.push("migrations"));
    const markIndexerStarted = jest.fn(() => order.push("started"));
    const assertRpcNetworkMatches = jest.fn(async () => {
      order.push("network");
    });
    const startPoller = jest.fn(() => order.push("poller"));
    const startReconciliationJob = jest.fn(() => order.push("reconciliation"));
    const registerShutdownHandlers = jest.fn(() => order.push("shutdown"));
    const listen = jest.fn((_app: express.Express, _port: string | number, onListening?: () => void) => {
      order.push("listen");
      onListening?.();
      return fakeServer();
    });
    const exit = jest.fn();

    await main({
      createApp: () => express(),
      port: 4321,
      runMigrations,
      markIndexerStarted,
      assertRpcNetworkMatches,
      startPoller,
      startReconciliationJob,
      registerShutdownHandlers,
      listen,
      exit,
    });

    expect(order).toEqual([
      "migrations",
      "started",
      "network",
      "poller",
      "reconciliation",
      "listen",
      "shutdown",
    ]);
    // The Express app is itself a function.
    expect(listen).toHaveBeenCalledWith(expect.any(Function), 4321, expect.any(Function));
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits 1 on a network mismatch without starting the poller or binding", async () => {
    const startPoller = jest.fn();
    const startReconciliationJob = jest.fn();
    const registerShutdownHandlers = jest.fn();
    const listen = jest.fn(() => fakeServer());
    const exit = jest.fn();

    await main({
      createApp: () => express(),
      assertRpcNetworkMatches: async () => {
        throw new Error("network mismatch");
      },
      startPoller,
      startReconciliationJob,
      registerShutdownHandlers,
      listen,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(startPoller).not.toHaveBeenCalled();
    expect(startReconciliationJob).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(registerShutdownHandlers).not.toHaveBeenCalled();
  });

  it("runs migrations before the network check", async () => {
    const order: string[] = [];
    await main({
      createApp: () => express(),
      runMigrations: () => order.push("migrations"),
      markIndexerStarted: () => order.push("started"),
      assertRpcNetworkMatches: async () => {
        order.push("network");
        throw new Error("mismatch");
      },
      startPoller: jest.fn(),
      startReconciliationJob: jest.fn(),
      listen: jest.fn(() => fakeServer()),
      exit: () => order.push("exit"),
    });
    expect(order).toEqual(["migrations", "started", "network", "exit"]);
  });
});
