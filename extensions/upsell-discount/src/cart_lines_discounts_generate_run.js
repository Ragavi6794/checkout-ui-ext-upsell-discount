import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Applies a dynamic per-line percentage discount ONLY to upsell cart lines
 * (those with _added_as_upsell=true set by the CheckoutBoost UI extension).
 * Regular cart lines are never touched by this function.
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasProductDiscountClass || !input.cart.lines.length) {
    return { operations: [] };
  }

  const candidates = [];

  for (const line of input.cart.lines) {
    // Only process lines explicitly flagged as upsell by the UI extension
    const isUpsell = line.attribute?.value === 'true';
    if (!isUpsell) continue;

    // Read the discount % that the UI extension stored as a cart-line attribute
    const pct = parseFloat(line.discountAttribute?.value ?? '0');

    // Skip if no valid discount is set (0, negative, or > 100)
    if (!pct || pct <= 0 || pct > 100) continue;

    candidates.push({
      message: `${pct}% off (upsell)`,
      targets: [
        {
          // Target only this specific upsell cart line — never regular lines
          cartLine: { id: line.id },
        },
      ],
      value: {
        percentage: { value: pct },
      },
    });
  }

  // No upsell lines found — return no operations so nothing is discounted
  if (!candidates.length) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          // Each candidate is independent: different % per upsell product
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}