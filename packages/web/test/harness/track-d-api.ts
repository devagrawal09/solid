/**
 * Track D test "API" module: a server fetcher and two helpers, declared to the
 * compiler through the cross-module authority summary (see the harness vite
 * configs: `fetchCatalog: "server"`, `byPrice` / `formatPrice: "pure"`).
 *
 * Each helper counts its calls so the hydration specs can prove the client
 * never re-runs a sealed memo's fetch, sort or formatting. The counters are a
 * measurement probe the compiler cannot see (the summary vouches for the
 * helpers); they are reset by the specs.
 */
export type Product = { id: number; name: string; price: number };

export const authorityStats = {
  fetches: 0,
  sorts: 0,
  formats: 0,
  reset() {
    this.fetches = 0;
    this.sorts = 0;
    this.formats = 0;
  }
};

const CATALOG: Product[] = [
  { id: 3, name: "saw", price: 2599 },
  { id: 1, name: "hammer", price: 1250 },
  { id: 2, name: "drill", price: 8900 },
  { id: 4, name: "tape", price: 399 }
];

/** A larger deterministic catalog for measurements (`category: "bulk"`). */
export const BULK_SIZE = 200;
export const BULK: Product[] = Array.from({ length: BULK_SIZE }, (_, i) => ({
  id: i + 1,
  name: "item" + i,
  // A deterministic shuffle so sorting has work to do.
  price: ((i * 7919) % 10007) + 100
}));

export function fetchCatalog(category: string): Promise<Product[]> {
  authorityStats.fetches++;
  const source = category === "bulk" ? BULK : CATALOG;
  return new Promise(resolve =>
    setTimeout(() => resolve(source.map(p => ({ ...p, name: `${category}:${p.name}` }))), 5)
  );
}

export function byPrice(a: Product, b: Product): number {
  authorityStats.sorts++;
  return a.price - b.price;
}

export function formatPrice(cents: number): string {
  authorityStats.formats++;
  return "$" + (cents / 100).toFixed(2);
}
