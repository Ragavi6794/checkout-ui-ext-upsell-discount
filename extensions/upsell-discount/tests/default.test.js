import { describe, it, expect } from 'vitest';
import { cartLinesDiscountsGenerateRun } from '../src/cart_lines_discounts_generate_run';

// Helper to build a minimal cart line
function makeLine(id, pct = null, isUpsell = false) {
  const attributes = [];
  if (isUpsell) attributes.push({ key: '_added_as_upsell', value: 'true' });
  if (pct !== null) attributes.push({ key: '_upsell_discount_percent', value: String(pct) });
  return { id, attributes };
}

function makeInput(lines, discountClasses = ['PRODUCT']) {
  return { cart: { lines }, discount: { discountClasses } };
}

describe('cartLinesDiscountsGenerateRun', () => {
  it('returns no operations when cart is empty', () => {
    const result = cartLinesDiscountsGenerateRun(makeInput([]));
    expect(result).toEqual({ operations: [] });
  });

  it('returns no operations when PRODUCT discount class is missing', () => {
    const result = cartLinesDiscountsGenerateRun(
      makeInput([makeLine('gid://shopify/CartLine/0', 20, true)], [])
    );
    expect(result).toEqual({ operations: [] });
  });

  it('returns no operations when no lines have upsell attributes', () => {
    const result = cartLinesDiscountsGenerateRun(
      makeInput([makeLine('gid://shopify/CartLine/0')])
    );
    expect(result).toEqual({ operations: [] });
  });

  it('applies discount to a single upsell line', () => {
    const result = cartLinesDiscountsGenerateRun(
      makeInput([makeLine('gid://shopify/CartLine/0', 20, true)])
    );
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].productDiscountsAdd.candidates).toHaveLength(1);
    expect(result.operations[0].productDiscountsAdd.candidates[0]).toMatchObject({
      message: '20% off (upsell)',
      targets: [{ cartLine: { id: 'gid://shopify/CartLine/0' } }],
      value: { percentage: { value: 20 } },
    });
    expect(result.operations[0].productDiscountsAdd.selectionStrategy).toBe('ALL');
  });

  it('applies different discounts to multiple upsell lines independently', () => {
    const result = cartLinesDiscountsGenerateRun(
      makeInput([
        makeLine('gid://shopify/CartLine/0', 10, true),
        makeLine('gid://shopify/CartLine/1', 20, true),
        makeLine('gid://shopify/CartLine/2'),         // regular line — no discount
      ])
    );
    const candidates = result.operations[0].productDiscountsAdd.candidates;
    expect(candidates).toHaveLength(2);
    expect(candidates[0].value.percentage.value).toBe(10);
    expect(candidates[1].value.percentage.value).toBe(20);
  });

  it('skips upsell lines where discount percent is 0 or invalid', () => {
    const result = cartLinesDiscountsGenerateRun(
      makeInput([
        makeLine('gid://shopify/CartLine/0', 0, true),
        makeLine('gid://shopify/CartLine/1', 110, true), // > 100, invalid
        makeLine('gid://shopify/CartLine/2', 15, true),  // valid
      ])
    );
    const candidates = result.operations[0].productDiscountsAdd.candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].value.percentage.value).toBe(15);
  });

  it('does not discount a line that has _upsell_discount_percent but not _added_as_upsell', () => {
    const line = {
      id: 'gid://shopify/CartLine/0',
      attributes: [{ key: '_upsell_discount_percent', value: '20' }],
    };
    const result = cartLinesDiscountsGenerateRun(makeInput([line]));
    expect(result).toEqual({ operations: [] });
  });
});
