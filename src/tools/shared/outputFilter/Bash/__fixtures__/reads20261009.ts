/**
 * The file reads of the 2026-10-09 session A/B on Sonnet 5.5, verbatim
 * (/tmp/session-cache-ab/20261009-{210710,213843,214707}). claudindev's 41
 * caps fell on 39 commands with a `cat`, and after each the model fetched the
 * files again with Read. `floor.test.ts` pins what the floor did to them;
 * `readLane.test.ts` what the read lane accepts.
 */

/** Pure reads (fileReadShape.ts): whole under the parked pass-through, capped without it. */
export const PURE_READS_2026_10_09 = [
  "git ls-files && cat README.md && wc -l src/* test/* 2>/dev/null",
  "cd src && cat catalog.ts cli.ts quote.ts receipt.ts shipping.ts types.ts money.ts discounts.ts regions.ts",
];

/** Reads that mix whole files with bounded ones: no predicate accepts them today. */
export const MIXED_READS_2026_10_09 = [
  "cat README.md; cd src; cat cart.ts catalog.ts cli.ts discounts.ts errors.ts money.ts quote.ts receipt.ts shipping.ts tax.ts types.ts; cat regions.ts | head -60",
  "cat README.md; cd src; cat cart.ts catalog.ts cli.ts discounts.ts errors.ts money.ts quote.ts receipt.ts shipping.ts tax.ts types.ts; grep -n \"\" regions.ts | head -60",
  "cd /tmp/session-cache-ab/20261009-210710/claudindev-r2; cat test/helpers.ts test/cli.test.ts; head -30 test/quote.test.ts test/catalog.test.ts test/receipt.test.ts; cat data/catalog.json | head -12",
  "cd /tmp/session-cache-ab/20261009-210710/claudindev-r2; sed -n 14,40p test/helpers.ts; cat test/cli.test.ts; sed -n 1,25p test/quote.test.ts; sed -n 1,20p test/catalog.test.ts; sed -n 1,25p test/receipt.test.ts",
  "cd /tmp/session-cache-ab/20261009-210710/claudindev-r1; cat test/helpers.ts; sed -n 1,30p test/quote.test.ts; sed -n 1,30p test/cli.test.ts; sed -n 1,25p test/catalog.test.ts; sed -n 1,20p test/receipt.test.ts; head -c 600 data/catalog.json",
  "cd /tmp/session-cache-ab/20261009-213843/placebo-r5; cat src/money.ts src/shipping.ts test/helpers.ts; head -30 test/quote.test.ts; head -30 test/cli.test.ts; tail -20 test/catalog.test.ts; head -30 test/receipt.test.ts; grep -n \"WELCOME\\|TEA-001\" -r data | head",
  "cd /tmp/session-cache-ab/20261009-213843/placebo-r2 && cat src/shipping.ts src/money.ts && cat test/quote.test.ts | head -50 && cat test/cli.test.ts | head -40 && grep -n \"describe\\|^import\" test/catalog.test.ts test/receipt.test.ts | head -30",
  "cat src/money.ts; sed -n 1,30p test/quote.test.ts; sed -n 1,12p test/catalog.test.ts; sed -n 1,30p test/receipt.test.ts; grep -n \"run(\" test/cli.test.ts | head -5; sed -n 40,75p test/cli.test.ts",
  "cd /tmp/session-cache-ab/20261009-214707/claudindev-r5; sed -n 27,80p README.md; echo ----; cat test/helpers.ts; echo ----; sed -n 1,30p test/quote.test.ts; echo ---; sed -n 1,25p test/cli.test.ts",
  "cd /tmp/session-cache-ab/20261009-214707/claudindev-r5; grep -n -i -B2 -A4 \"shipping\\|free\" README.md | head -60; cat test/helpers.ts; head -30 test/quote.test.ts; head -20 test/cli.test.ts test/catalog.test.ts test/receipt.test.ts; head -c 600 data/catalog.json",
  "cd test && cat helpers.ts && head -30 quote.test.ts catalog.test.ts && grep -n \"run(\\|Io\\|out\" cli.test.ts | head -20; grep -n \"TEA-001\\|WEL\\|sku\" ../data/catalog.json | head -20",
  "cd /tmp/session-cache-ab/20261009-214707/claudindev-r3; sed -n 15,200p README.md; cat test/helpers.ts; sed -n 1,40p test/quote.test.ts; sed -n 1,30p test/cli.test.ts; sed -n 1,25p test/catalog.test.ts; head -c 600 data/catalog.json",
  "cd /tmp/session-cache-ab/20261009-213843/placebo-r3; cat src/money.ts test/helpers.ts; sed -n 1,40p test/quote.test.ts; grep -n \"Tiers\\|tiers\" -r README.md data | head; grep -n \"TEA-001\" data/catalog.json",
  "cd /tmp/session-cache-ab/20261009-213843/placebo-r3; cat test/helpers.ts; sed -n 1,20p test/quote.test.ts; sed -n 1,14p test/catalog.test.ts; tail -15 test/quote.test.ts; tail -12 test/receipt.test.ts; sed -n 1,12p test/receipt.test.ts",
];
