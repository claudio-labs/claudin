Thanks! Next request from the product team: coupons can now expire.

- A coupon in the cart may carry an optional `"expires": "YYYY-MM-DD"`; it is valid through that date, inclusive.
- The CLI gets a `--date YYYY-MM-DD` option for the pricing date, defaulting to today.
- An expired coupon is not applied, and it doesn't make the quote fail. The text receipt lists it after the applied coupons as `Ignored coupon <CODE> (expired)`, and the JSON output gets an `"ignoredCoupons": [{ "code": "<CODE>", "reason": "expired" }]` array (empty when nothing was ignored).
- A malformed `expires` or `--date` is a validation error (exit code 2).

Add tests for it and run the whole suite. When everything passes, commit all the work from both requests in this repo with a conventional-commit message.
