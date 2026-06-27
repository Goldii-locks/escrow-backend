import { z } from "zod";
import { isValidStellarContractId } from "../utils/stellar.js";

export const contractIdParamsSchema = z.object({
  contractId: z
    .string({ required_error: "contractId is required" })
    .refine(isValidStellarContractId, {
      message: "contractId must be a valid Stellar contract address (C...)",
    }),
});

export type ContractIdParams = z.infer<typeof contractIdParamsSchema>;
