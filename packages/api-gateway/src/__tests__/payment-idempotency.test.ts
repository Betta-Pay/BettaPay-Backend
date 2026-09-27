import { describe, it, expect, vi } from "vitest";
import { saveIdempotencyKey } from "../lib/idempotency";
import { Redis } from "ioredis";

vi.mock("ioredis");

describe("Payment Idempotency Key Expiry", () => {
  it("should enforce a 24-hour TTL when saving keys to Redis", async () => {
    const mockSet = vi.fn();
    vi.spyOn(Redis.prototype, 'set').mockImplementation(mockSet);

    await saveIdempotencyKey("test-key-123", { success: true });

    // Verifies that Redis is explicitly instructed to expire the key after 24 hours (86400s)
    expect(mockSet).toHaveBeenCalledWith("idempotency:test-key-123", expect.any(String), "EX", 86400);
  });
});
