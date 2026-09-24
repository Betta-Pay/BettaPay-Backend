import { checkMerchantSuspension } from "../../middleware/merchantCheck";

// When defining your route blocks, register it as a preHandler:
fastify.register(async function (merchantRoutes) {
  merchantRoutes.addHook("preHandler", checkMerchantSuspension);

  // Your route definitions here run safely *after* the suspension verification
  merchantRoutes.get("/listings", async (req, res) => { /* ... */ });
});
