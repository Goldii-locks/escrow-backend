import rateLimit from "express-rate-limit";

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);

const generalMax =
  process.env.NODE_ENV === "test"
    ? 0
    : parseInt(process.env.RATE_LIMIT_MAX || "100", 10);

const strictMax =
  process.env.NODE_ENV === "test"
    ? 0
    : parseInt(process.env.RATE_LIMIT_MAX_STRICT || "10", 10);

export const generalLimiter = rateLimit({
  windowMs,
  max: generalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later." },
});

export const strictLimiter = rateLimit({
  windowMs,
  max: strictMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please try again later." },
});
