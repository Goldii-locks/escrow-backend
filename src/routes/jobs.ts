import { Router } from "express";
import byWalletRouter from "./jobs/by-wallet.js";
import createJobDraftRouter from "./jobs/create-job-draft.js";
import historyRouter from "./jobs/history.js";
import whitelistRouter from "./jobs/whitelist.js";
import buildTxRouter from "./jobs/build-tx.js";
import getJobRouter from "./jobs/get-job.js";
import partialReleaseRouter from "./jobs/partial-release.js";
import timeRemainingRouter from "./jobs/time-remaining.js";
import claimAutoReleaseRouter from "./jobs/claim-auto-release.js";
import submitRouter from "./jobs/submit.js";

const router = Router();

// Mount order mirrors the original registration order in routes/jobs.ts.
// In particular /by-wallet/:address and /build-tx stay ahead of /:contractId
// so static paths are never swallowed by the contract-ID param route.
router.use(byWalletRouter);
router.use(createJobDraftRouter);
router.use(historyRouter);
router.use(whitelistRouter);
router.use(buildTxRouter);
router.use(getJobRouter);
router.use(partialReleaseRouter);
router.use(timeRemainingRouter);
router.use(claimAutoReleaseRouter);
router.use(submitRouter);

export { assertRpcNetworkMatches, getRpcUrl, maskAddress } from "./jobs/shared.js";
export {
  whitelistCache,
  resetWhitelistCache,
  claimAutoReleaseCache,
  resetClaimAutoReleaseCache,
  submitCache,
  resetSubmitCache,
  buildTxCache,
  resetBuildTxCache,
  timeRemainingCache,
  resetTimeRemainingCache,
  partialReleaseCache,
  resetPartialReleaseCache,
  feePreviewCache,
  resetFeePreviewCache,
  UNSIGNED_TX_TIMEOUT_S,
  UNSIGNED_TX_MIN_REMAINING_S,
} from "./jobs/caches.js";
export { SimError, classifySimError, classifySubmitError } from "./jobs/errors.js";

export default router;
