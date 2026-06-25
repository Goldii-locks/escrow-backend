import { z } from "zod";
import type { NextFunction, Request, Response } from "express";
import { StrKey } from "@stellar/stellar-sdk";

export const contractIdParamsSchema = z.object({
  contractId: z.string().refine((val) => StrKey.isValidContract(val), {
    message: "contractId must be a valid Stellar contract address (C...)",
  }),
});

export type ContractIdParams = z.infer<typeof contractIdParamsSchema>;

export function validateContractIdParams(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = contractIdParamsSchema.safeParse(req.params);

  if (!result.success) {
    const errorMessages = result.error.issues.map((e) => e.message);
    res.status(400).json({
      success: false,
      error: errorMessages.join(", "),
    });
    return;
  }

  next();
}