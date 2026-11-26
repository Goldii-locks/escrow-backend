import fs from "node:fs";
import express from "express";
import { createApp } from "../src/app.js";

// #896: keep the spec honest. Intentional exceptions are listed explicitly;
// the /api/v1/* mounts are duplicates of /api/* (documented via the /api/v1
// server entry and the Deprecation header note in the spec).
const ALLOWLIST = new Set<string>([]);
const IGNORED_METHODS = new Set(["OPTIONS", "HEAD"]);

function normalize(path: string): string {
  const withBraces = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/+/g, "/");
  return withBraces.length > 1 && withBraces.endsWith("/")
    ? withBraces.slice(0, -1)
    : withBraces || "/";
}

/** Walk createApp()'s router stack (including nested routers) as METHOD /path. */
function routerRoutes(): Set<string> {
  const routerProto = (express.Router as unknown as { prototype: any }).prototype;
  const originalUse = routerProto.use as (...args: unknown[]) => unknown;
  const mounts = new WeakMap<object, string[]>();

  // Router.use records the mount path of every mounted sub-router. This also
  // sees app.use(), which proxies to the app's Router.
  routerProto.use = function (this: unknown, path: unknown, ...handlers: unknown[]) {
    const isPath = typeof path === "string";
    const fns = isPath ? handlers : [path, ...handlers];
    const prefix = isPath ? (path as string) : "";
    for (const fn of fns) {
      if (fn && typeof fn === "function" && Array.isArray((fn as { stack?: unknown }).stack)) {
        const list = mounts.get(fn as object) ?? [];
        list.push(prefix);
        mounts.set(fn as object, list);
      }
    }
    return originalUse.apply(this, [path, ...handlers]);
  };

  let app: express.Express;
  try {
    app = createApp();
  } finally {
    routerProto.use = originalUse;
  }

  const routes = new Set<string>();
  const walk = (stack: Array<any>, prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          const key = method.toUpperCase();
          if (IGNORED_METHODS.has(key)) continue;
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          for (const p of paths) {
            const route = `${key} ${normalize(`${prefix}/${String(p)}`)}`;
            if (!ALLOWLIST.has(route)) routes.add(route);
          }
        }
      } else if (Array.isArray(layer.handle?.stack)) {
        // A mounted router: recover its mount path from the layer's matcher.
        const candidates = mounts.get(layer.handle as object) ?? [""];
        let mount = "";
        for (const candidate of candidates) {
          const probe = candidate === "" ? "/__probe__" : `${candidate}/__probe__`;
          if (layer.match(probe) && typeof layer.path === "string") {
            if (candidate === "") {
              mount = "";
              break;
            }
            if ((layer.path as string).length > mount.length) mount = layer.path as string;
          }
        }
        walk(layer.handle.stack as Array<any>, `${prefix}${mount}`);
      }
    }
  };
  walk(app.router.stack as Array<any>, "");
  return routes;
}

function documentedRoutes(): Set<string> {
  const lines = fs.readFileSync("docs/openapi.yaml", "utf8").split(/\r?\n/);
  const routes = new Set<string>();
  let inPaths = false;
  let current: string | null = null;

  for (const line of lines) {
    if (line.startsWith("paths:")) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[A-Za-z]/.test(line)) break;
    const pathMatch = line.match(/^ {2}(\/[^:]*):\s*$/);
    if (pathMatch) {
      current = pathMatch[1];
      continue;
    }
    const methodMatch = line.match(/^ {4}(get|post|put|delete|patch):/i);
    if (methodMatch && current) {
      routes.add(`${methodMatch[1].toUpperCase()} ${current}`);
    }
  }
  return routes;
}

/** /api/v1/* is the same route as /api/* (documented once with a server entry). */
function unversioned(route: string): string | null {
  const match = route.match(/^([A-Z]+) \/api\/v1(\/.*)$/);
  return match ? `${match[1]} /api${match[2]}` : null;
}

describe("OpenAPI vs Express router (#896)", () => {
  it("documents every registered route (or an explicitly allowed exception)", () => {
    const documented = documentedRoutes();
    const missing = [...routerRoutes()].filter((route) => {
      if (documented.has(route)) return false;
      const alias = unversioned(route);
      return !alias || !documented.has(alias);
    });
    expect(missing).toEqual([]);
  });

  it("has no documented route that the app does not register", () => {
    const registered = routerRoutes();
    const stale = [...documentedRoutes()].filter(
      (route) => !registered.has(route) && !registered.has(route.replace(" /api/", " /api/v1/")),
    );
    expect(stale).toEqual([]);
  });
});
