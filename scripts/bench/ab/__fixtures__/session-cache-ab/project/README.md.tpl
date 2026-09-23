# pricing-engine

Prices a shopping cart for the storefront: catalog prices, then coupons, then
tax, then shipping. Plain TypeScript on [Bun](https://bun.sh), no dependencies.

```sh
bun test                                              # run the test suite
bun run src/cli.ts quote data/carts/basic-us.json     # print a receipt
bun run src/cli.ts quote data/carts/coupons-eu.json --region UK
```

## Layout

| file | what it does |
|---|---|
| `src/cli.ts` | argument parsing and exit codes (0 ok, 2 bad input, 1 bug) |
| `src/catalog.ts` | loads and validates `data/catalog.json` |
| `src/cart.ts` | parses and validates a cart file, merges duplicate lines |
| `src/quote.ts` | the pricing pipeline below |
| `src/discounts.ts` | coupons |
| `src/tax.ts` | tax per line |
| `src/shipping.ts` | parcel weight and shipping cost |
| `src/regions.ts` | currency, tax rates and shipping rules per region |
| `src/receipt.ts` | the text receipt |
| `src/money.ts` | cents helpers: percentages and formatting |
| `src/errors.ts` | the errors reported to the user |
| `src/types.ts` | shared types |

Tests live in `test/`, one file per module.

## Pricing rules

All amounts are **integer cents**, and every percentage goes through
`percentOf()`, which rounds **half-up to a whole cent**.

1. **Lines.** Duplicate lines for the same SKU are merged first. Each line
   costs `unitCents × qty` (its `lineCents`); the subtotal is their sum.
2. **Coupons** apply in the order they appear in the cart. A `percent` coupon
   covers every line, a `category` coupon only the lines of its category. Each
   coupon takes its percentage off what is *left* of each line it covers after
   the coupons before it, rounding per line — two 10% coupons take 19%.
   A coupon that covers no line is an error, and a code can be used only once.
3. **Tax** is charged per line on what is left of it after coupons, at the rate
   of the product's tax class in the region, rounded per line.
4. **Shipping** depends on the parcel weight: the base fee covers the first
   kilogram and every further kilogram started adds the per-kg fee. An order
   with nothing to ship (only weightless items) pays nothing. Shipping is
   **free when the merchandise amount after coupons** reaches the region's
   free-shipping threshold.
5. **Total** = subtotal − coupons + tax + shipping.

| region | currency | standard | reduced | exempt | base fee | per extra kg | free from |
|---|---|---|---|---|---|---|---|
| US | USD | 8.25% | 4% | 0% | $5.99 | $1.50 | $75.00 |
| EU | EUR | 21% | 9% | 0% | €8.99 | €2.00 | €100.00 |
| UK | GBP | 20% | 5% | 0% | £4.99 | £1.75 | £60.00 |

## File formats

A cart — `region` defaults to `US`, and `--region` overrides it:

```json
{
  "region": "EU",
  "lines": [{ "sku": "COF-001", "qty": 2 }],
  "coupons": [{ "code": "COFFEE15", "kind": "category", "category": "coffee", "value": 15 }]
}
```

A catalog entry (`taxClass` is `standard`, `reduced` or `exempt`):

```json
{ "sku": "TEA-001", "name": "Green Tea 100g", "unitCents": 899,
  "category": "tea", "taxClass": "reduced", "weightGrams": 120 }
```
