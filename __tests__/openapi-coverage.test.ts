import fs from "fs";
import jobRoutes from "../src/routes/jobs.js";
import adminRoutes from "../src/routes/admin.js";
import webhookRoutes from "../src/routes/webhooks.js";

function getRegisteredRoutes() {
  const routes: { method: string; path: string }[] = [];

  const extract = (router: any, prefix: string) => {
    for (const layer of router.stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter((m) => m !== "_all" && m !== "options");
        const routePath = layer.route.path;
        const paths = Array.isArray(routePath) ? routePath : [routePath];
        for (const p of paths) {
          for (const m of methods) {
            routes.push({
              method: m.toUpperCase(),
              path: (prefix + p).replace(/\\/g, "/"),
            });
          }
        }
      }
    }
  };

  extract(jobRoutes, "/api/jobs");
  extract(adminRoutes, "/api/admin");
  extract(webhookRoutes, "/api/webhooks");

  return routes;
}

function parseOpenApiPaths(openApiPath: string = "docs/openapi.yaml"): Set<string> {
  const content = fs.readFileSync(openApiPath, "utf8");
  const documented = new Set<string>();

  // Extract path and method keys under paths:
  const lines = content.split(/\r?\n/);
  let inPaths = false;
  let currentPath: string | null = null;

  for (const line of lines) {
    if (line.startsWith("paths:")) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      // Top-level sections exit paths
      if (/^[a-zA-Z]/.test(line)) {
        break;
      }
      const pathMatch = line.match(/^ {2}(\/[^:]+):/);
      if (pathMatch) {
        currentPath = pathMatch[1];
        continue;
      }
      const methodMatch = line.match(/^ {4}(get|post|put|delete|patch):/i);
      if (methodMatch && currentPath) {
        const method = methodMatch[1].toUpperCase();
        documented.add(`${method} ${currentPath}`);
      }
    }
  }

  return documented;
}

describe("API documentation coverage (docs/openapi.yaml & README.md)", () => {
  it("documents every router endpoint in docs/openapi.yaml", () => {
    const routes = getRegisteredRoutes();
    const documented = parseOpenApiPaths();

    // Convert express route param syntax :param to OpenAPI syntax {param}
    const missing: string[] = [];

    for (const r of routes) {
      const openApiPath = r.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
      const key = `${r.method} ${openApiPath}`;
      // Check if documented
      if (!documented.has(key)) {
        missing.push(key);
      }
    }

    expect(missing).toEqual([]);
  });

  it("mentions every route in README.md", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const routes = getRegisteredRoutes();

    const missingInReadme: string[] = [];
    for (const r of routes) {
      // Check if method and path (or path pattern) are present in README
      if (!readme.includes(r.path) && !readme.includes(r.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}"))) {
        missingInReadme.push(`${r.method} ${r.path}`);
      }
    }

    expect(missingInReadme).toEqual([]);
  });
});
