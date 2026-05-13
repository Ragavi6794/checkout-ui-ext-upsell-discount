import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

export default async () => {
  render(<App />, document.body);
};

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const PRODUCT_FIELDS = /* GraphQL */ `
  fragment ProductFields on Product {
    id
    title
    featuredImage { url(transform: { maxWidth: 120 }) altText }
    variants(first: 10) {
      nodes {
        id
        title
        availableForSale
        price { amount currencyCode }
      }
    }
    upsellDiscount: metafield(namespace: "custom", key: "upsell_discount_percent") {
      value
    }
  }
`;

const QUERY_VARIANT_UPSELLS = /* GraphQL */ `
  ${PRODUCT_FIELDS}
  query GetVariantUpsells($variantId: ID!) {
    node(id: $variantId) {
      ... on ProductVariant {
        variantUpsells: metafield(namespace: "custom", key: "upsell_variant_product") {
          references(first: 20) {
            nodes { ...ProductFields }
          }
        }
        product {
          id
          sourceDiscount: metafield(namespace: "custom", key: "upsell_discount_percent") {
            value
          }
          productUpsells: metafield(namespace: "custom", key: "upsell_product") {
            references(first: 20) {
              nodes { ...ProductFields }
            }
          }
        }
      }
    }
  }
`;

const QUERY_COLLECTION_FALLBACK = /* GraphQL */ `
  ${PRODUCT_FIELDS}
  query GetCollectionProducts($handle: String!) {
    collection(handle: $handle) {
      products(first: 20) {
        nodes { ...ProductFields }
      }
    }
  }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isProductInStock(product) {
  return product.variants?.nodes?.some((v) => v.availableForSale) ?? false;
}

function formatMoney(amount, currencyCode) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
    }).format(parseFloat(amount));
  } catch {
    return `${currencyCode} ${parseFloat(amount).toFixed(2)}`;
  }
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const settings = shopify.settings.value ?? {};
  const sectionTitle = settings.section_title || shopify.i18n.translate('sectionTitle');
  const fallbackHandle = String(settings.fallback_collection_handle ?? '');
  const maxProducts = parseInt(String(settings.max_products ?? '2'), 10) || 2;
  const defaultDiscount = parseInt(String(settings.default_discount_percent ?? '0'), 10) || 0;

  // Snapshot cart at mount time — used only for initial "already in cart" detection
  // and for fetching upsells. We deliberately do NOT re-fetch when cart changes so
  // that ProductCards are never unmounted mid-session (which would kill the Remove state).
  const initialCartLines = shopify.lines.value ?? [];
  const cartVariantIds = new Set(initialCartLines.map((l) => l.merchandise.id));
  const cartProductIds = new Set(
    initialCartLines.map((l) => l.merchandise.product?.id).filter(Boolean)
  );

  const [upsells, setUpsells] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetchUpsells() {
      setLoading(true);
      try {
        // Query every cart line in parallel — each can contribute its own upsells
        const lineResults = await Promise.allSettled(
          initialCartLines.map((line) =>
            shopify.query(QUERY_VARIANT_UPSELLS, {
              variables: { variantId: line.merchandise.id },
            })
          )
        );

        // Collect all upsell products, tracking which lines had no metafield upsells
        const seen = new Set();
        const candidates = [];
        let anyLineHasMetafieldUpsells = false;

        for (const res of lineResults) {
          if (res.status !== 'fulfilled') continue;
          const data = /** @type {any} */ (res.value)?.data;

          const variantNodes = data?.node?.variantUpsells?.references?.nodes ?? [];
          const productNodes = data?.node?.product?.productUpsells?.references?.nodes ?? [];

          // Variant metafield takes priority over product metafield per line
          const lineUpsells = variantNodes.length > 0 ? variantNodes : productNodes;

          // Discount % is set on the SOURCE cart product, not on each upsell product
          const sourceDiscountPct = parseInt(
            data?.node?.product?.sourceDiscount?.value ?? '0', 10
          ) || 0;

          if (lineUpsells.length > 0) anyLineHasMetafieldUpsells = true;

          for (const product of lineUpsells) {
            if (!seen.has(product.id)) {
              seen.add(product.id);
              // Attach the source cart product's discount so ProductCard can use it
              candidates.push({ ...product, effectiveDiscountPct: sourceDiscountPct });
            }
          }
        }

        // Fallback collection: used when NO cart line had any metafield upsells
        if (!anyLineHasMetafieldUpsells && fallbackHandle) {
          const result = await shopify.query(QUERY_COLLECTION_FALLBACK, {
            variables: { handle: fallbackHandle },
          });
          const data = /** @type {any} */ (result)?.data;
          for (const product of data?.collection?.products?.nodes ?? []) {
            if (!seen.has(product.id)) {
              seen.add(product.id);
              candidates.push(product);
            }
          }
        }

        const filtered = candidates
          .filter(isProductInStock)
          .filter((p) => !cartProductIds.has(p.id))
          .slice(0, maxProducts);

        if (!cancelled) {
          console.log('[CheckoutBoost] upsells fetched:', filtered.map((p) => ({
            title: p.title,
            effectiveDiscountPct: p.effectiveDiscountPct ?? 0,
            ownDiscount: p.upsellDiscount?.value ?? 'NOT SET',
          })));
          setUpsells(filtered);
        }
      } catch (err) {
        console.error('[CheckoutBoost] fetch error:', err);
        if (!cancelled) setUpsells([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchUpsells();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount — cart changes must not re-fetch (would unmount cards)

  if (loading) {
    return (
      <s-stack padding="base" alignItems="center">
        <s-spinner />
        <s-text>{shopify.i18n.translate('loading')}</s-text>
      </s-stack>
    );
  }

  if (upsells.length === 0) return null;

  return (
    <s-stack padding="base" gap="base">
      <s-text type="strong">{sectionTitle}</s-text>
      {upsells.map((product) => (
        <ProductCard
          key={product.id}
          product={product}
          cartVariantIds={cartVariantIds}
          defaultDiscount={defaultDiscount}
        />
      ))}
    </s-stack>
  );
}

// ─── ProductCard ──────────────────────────────────────────────────────────────

function ProductCard({ product, cartVariantIds, defaultDiscount }) {
  const availableVariants = product.variants?.nodes?.filter((v) => v.availableForSale) ?? [];
  const [selectedVariantId, setSelectedVariantId] = useState(
    availableVariants[0]?.id ?? ''
  );
  // Fully self-contained: initialised from cart, then toggled locally on success
  const [isAdded, setIsAdded] = useState(
    () => cartVariantIds.has(availableVariants[0]?.id ?? '')
  );
  const [busy, setBusy] = useState(false); // true while API call in flight

  const selectedVariant = availableVariants.find((v) => v.id === selectedVariantId) ?? availableVariants[0];
  // Priority: source cart product's discount → upsell product's own discount → extension default
  const discountPct =
    (product.effectiveDiscountPct > 0 ? product.effectiveDiscountPct : null) ??
    (parseInt(product.upsellDiscount?.value ?? '0', 10) || null) ??
    defaultDiscount;

  const originalAmount = parseFloat(selectedVariant?.price.amount ?? '0');
  const currencyCode = selectedVariant?.price.currencyCode ?? 'INR';
  const discountedAmount = discountPct > 0
    ? originalAmount * (1 - discountPct / 100)
    : originalAmount;

  const originalPrice = formatMoney(originalAmount, currencyCode);
  const discountedPrice = formatMoney(discountedAmount, currencyCode);

  function handleVariantChange(e) {
    const newId = /** @type {any} */ (e.target).value;
    setSelectedVariantId(newId);
    // Reflect actual cart state for the newly selected variant
    setIsAdded((shopify.lines.value ?? []).some((l) => l.merchandise.id === newId));
  }

  async function handleAdd() {
    if (!selectedVariantId || busy) return;
    setBusy(true);
    try {
      const attrs = [{ key: '_added_as_upsell', value: 'true' }];
      if (discountPct > 0) {
        attrs.push({ key: '_upsell_discount_percent', value: String(discountPct) });
      }
      const result = await shopify.applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: selectedVariantId,
        quantity: 1,
        attributes: attrs,
      });
      if (/** @type {any} */ (result)?.type !== 'error') {
        setIsAdded(true);
      }
    } catch (err) {
      console.error('[CheckoutBoost] add error:', err);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!selectedVariantId || busy) return;
    // Read live cart at call time to get the correct line id
    const lines = shopify.lines.value ?? [];
    const line =
      lines.find((l) => l.merchandise.id === selectedVariantId) ??
      lines.find((l) => l.merchandise.product?.id === product.id);
    if (!line) return;
    setBusy(true);
    try {
      const result = await shopify.applyCartLinesChange({
        type: 'removeCartLine',
        id: line.id,
        quantity: line.quantity,
      });
      if (/** @type {any} */ (result)?.type !== 'error') {
        setIsAdded(false);
      }
    } catch (err) {
      console.error('[CheckoutBoost] remove error:', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-box border="base base" borderRadius="base" padding="base">
      <s-grid gridTemplateColumns="80px 1fr auto" gap="base" alignItems="center">
        {product.featuredImage ? (
          <s-image
            src={product.featuredImage.url}
            alt={product.featuredImage.altText ?? product.title}
            aspectRatio="1"
            inlineSize="80px"
          />
        ) : (
          <s-box inlineSize="80px" />
        )}

        <s-stack gap="small">
          <s-text type="strong">{product.title}</s-text>

          {availableVariants.length > 1 && (
            <s-select
              value={selectedVariantId}
              onChange={handleVariantChange}
              label={shopify.i18n.translate('selectVariant')}
            >
              {availableVariants.map((v) => (
                <option key={v.id} value={v.id}>{v.title}</option>
              ))}
            </s-select>
          )}

          <s-stack direction="inline" gap="small" alignItems="center">
            {discountPct > 0 ? (
              <>
                <s-text type="strong">{discountedPrice}</s-text>
                <s-text type="redundant">{originalPrice}</s-text>
                <s-badge tone="neutral">{discountPct}% off</s-badge>
              </>
            ) : (
              <s-text>{originalPrice}</s-text>
            )}
          </s-stack>
        </s-stack>

        <s-stack alignItems="center">
          {isAdded ? (
            <s-button
              variant="secondary"
              loading={busy}
              disabled={busy}
              onClick={handleRemove}
            >
              {shopify.i18n.translate('removeFromOrder')}
            </s-button>
          ) : (
            <s-button
              variant="primary"
              loading={busy}
              disabled={busy}
              onClick={handleAdd}
            >
              {shopify.i18n.translate('addToOrder')}
            </s-button>
          )}
        </s-stack>
      </s-grid>
    </s-box>
  );
}
