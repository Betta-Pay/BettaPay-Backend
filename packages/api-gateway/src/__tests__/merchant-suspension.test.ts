import { describe, it, expect, vi } from "vitest";
import { checkMerchantSuspension } from "../middleware/merchantCheck";

describe("Merchant Suspension Early Lifecycle Checks", () => {
  it("should reject suspended merchants before handling heavy payloads or route handlers", async () => {
    const mockRequest = {
      headers: { "x-merchant-id": "merch_suspended_99" },
      params: {},
    } as any;

    const mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    await checkMerchantSuspension(mockRequest, mockReply);

    // Verify a consistent 403 Forbidden payload is fired upfront
    expect(mockReply.status).toHaveBeenCalledWith(403);
    expect(mockReply.send).toHaveBeenCalledWith(expect.objectContaining({
      code: "MERCHANT_SUSPENDED"
    }));
  });
});
