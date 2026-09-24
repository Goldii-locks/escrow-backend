import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { stablecoinCentsMultiplier } from '../utils/stablecoin_cents_multiplier';

const router = Router();

/**
 * Rate limiter for client requests hitting the stablecoin_cents_multiplier
 * conversion endpoint. Requests exceeding the configured threshold receive
 * a 429 response.
 */
export const stablecoinCentsMultiplierLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests to stablecoin_cents_multiplier. Please retry later.',
  },
});

router.post(
  '/stablecoin-cents-multiplier',
  stablecoinCentsMultiplierLimiter,
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const { amount, multiplier } = req.body ?? {};

      if (typeof amount !== 'number' || typeof multiplier !== 'number') {
        return res.status(400).json({
          error: 'amount and multiplier must be numbers',
        });
      }

      const result = stablecoinCentsMultiplier(amount, multiplier);
      return res.status(200).json({ result });
    } catch (err) {
      return next(err);
    }
  },
);

export default router;
