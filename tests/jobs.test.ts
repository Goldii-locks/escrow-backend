import request from 'supertest';
import express from 'express';
import router from '../src/routes/jobs';

const app = express();
app.use(router);

describe('GET /api/jobs/by-wallet/:address', () => {
  const mockAddress = 'GBRpBAIPST7Y7Y...';

  it('should return a paginated list of jobs with correctly assigned roles', async () => {
    const res = await request(app)
      .get(`/api/jobs/by-wallet/${mockAddress}?page=1&limit=10`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.jobs)).toBe(true);
    expect(res.body.jobs[0]).toHaveProperty('contractId');
    expect(res.body.jobs[0]).toHaveProperty('role');
    expect(res.body.jobs[0]).toHaveProperty('funded');
    expect(res.body.jobs[0]).toHaveProperty('milestones');
  });

  it('should respond in under 2 seconds', async () => {
    const start = Date.now();
    await request(app).get(`/api/jobs/by-wallet/${mockAddress}`);
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(2000);
  });
});