import { Router, Request, Response } from 'express';
// FIXED: Added the required .js extension for native ES Modules
import { cacheService } from '../services/cacheService.js';

const router = Router();

router.get('/api/jobs/by-wallet/:address', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const { address } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;

  if (!address) {
    return res.status(400).json({ success: false, error: 'Wallet address is required' });
  }

  const cacheKey = `jobs:${address}`;
  let cachedJobs = cacheService.get<any[]>(cacheKey);

  try {
    if (!cachedJobs) {
      const allFetchedJobs = [
        { contractId: "C123456789", client: address, freelancer: "G_FREE...", arbiter: "G_ARB...", funded: true, milestones: 3 },
        { contractId: "C987654321", client: "G_CLI...", freelancer: address, arbiter: "G_ARB...", funded: true, milestones: 2 },
        { contractId: "C112233445", client: "G_CLI...", freelancer: "G_FREE...", arbiter: address, funded: false, milestones: 1 }
      ];

      cachedJobs = allFetchedJobs.map(job => {
        let role = 'unknown';
        if (job.client === address) role = 'client';
        else if (job.freelancer === address) role = 'freelancer';
        else if (job.arbiter === address) role = 'arbiter';

        return {
          contractId: job.contractId,
          role,
          funded: job.funded,
          milestones: job.milestones
        };
      });

      cacheService.set(cacheKey, cachedJobs, 30000);
    }

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedJobs = cachedJobs.slice(startIndex, endIndex);

    const duration = Date.now() - startTime;
    res.setHeader('X-Response-Time', `${duration}ms`);

    return res.status(200).json({
      success: true,
      jobs: paginatedJobs
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

export default router;