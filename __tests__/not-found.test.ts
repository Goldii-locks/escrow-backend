import request from "supertest";

// The general /api limiter rejects everything under NODE_ENV=test (max 0), so
// load the app as in development to reach the catch-all route.
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
const { createApp } = await import("../src/app.js");
process.env.NODE_ENV = originalNodeEnv;

describe("unknown routes (#869)", () => {
  it("GET /api/nope returns the JSON 404 envelope with helmet headers", async () => {
    const res = await request(createApp()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toEqual({ success: false, error: "Not found" });
  });
});
