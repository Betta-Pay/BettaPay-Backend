import { FastifyRequest, FastifyReply } from "fastify";
import { getMerchantStatusFromDb } from "@/lib/db"; // Adjust matching database or cache layer string

/**
 * Early preHandler hook that intercepts requests before body parsing occurs.
 * Rejects suspended merchants immediately to prevent resource consumption and information leaks.
 */
export async function checkMerchantSuspension(request: FastifyRequest, reply: FastifyReply) {
  // Extract merchant identity context safely from headers or route parameters
  const merchantId = (request.headers["x-merchant-id"] || request.params?.["merchantId"]) as string;

  if (!merchantId) {
    return; // Pass through if not a merchant-scoped route context
  }

  try {
    const merchant = await getMerchantStatusFromDb(merchantId);

    if (merchant && merchant.status === "SUSPENDED") {
      // Return a consistent suspension error explicitly before heavy work / body parsing begins
      return reply.status(403).send({
        error: "Forbidden",
        message: "Merchant account is suspended.",
        code: "MERCHANT_SUSPENDED"
      });
    }
  } catch (error) {
    // Fail closed for safety if the lookup fails
    return reply.status(500).send({ error: "Internal validation failure." });
  }
}
