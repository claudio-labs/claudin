This repo is `pricing-engine`, a small TypeScript project that runs on Bun (the pricing rules are in README.md). I need three changes, each with tests:

1. **Bulk pricing.** A catalog product may have an optional `tiers` array, for example
   `"tiers": [{ "minQty": 10, "percentOff": 5 }, { "minQty": 50, "percentOff": 12 }]`.
   When a cart line's qty reaches a tier's `minQty`, the unit price drops by that tier's `percentOff`; only the highest tier reached applies. The discounted unit price is `unitCents - percentOf(unitCents, percentOff)` (so it rounds half-up per unit, like every other percentage here), and the line costs that unit price × qty. Tiers apply before coupons: coupons, tax and shipping all see the tiered amounts.
   Validate tiers when the catalog loads: `minQty` must be an integer of at least 2 and strictly increasing from one tier to the next, and `percentOff` a number above 0 and below 100. A bad tier is a `ValidationError` whose message names the product's SKU.
   On the text receipt, a line priced by a tier shows it after the product, e.g. `10 x Green Tea 100g (TEA-001) (bulk -5%)`.

2. **JSON output.** `bun run src/cli.ts quote <cart.json> --json` prints the quote as one JSON object on stdout and nothing else:
   `{ "currency", "lines": [{ "sku", "qty", "unitCents", "lineCents" }], "subtotalCents", "discountCents", "taxCents", "shippingCents", "totalCents" }`, where `unitCents` is the unit price after any bulk tier and `lineCents` is `unitCents × qty`, before coupons. Errors still go to stderr with exit code 2.

3. **A bug from support:** "A US customer bought $75.98 of goods, used the WELCOME10 coupon (10% off) and got free shipping. After the coupon the order was $68.38, and free shipping only starts at $75.00." Find the cause, fix it and add a regression test.

Keep the existing tests passing and don't add dependencies. Don't commit yet — just give me a short summary when you're done.
