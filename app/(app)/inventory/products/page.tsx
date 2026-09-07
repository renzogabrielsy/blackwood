import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';

import { getProductsData } from '@/lib/products/queries';
import { ProductsView } from './components/products-view';

/**
 * `/inventory/products` — finished-goods (flecon) inventory, one tab per product grade.
 *
 * Server Component. ONE adapter call (`getProductsData`) fills the whole page's
 * `ProductsData` contract from the four `view_product_*` views; the client shell below
 * formats it and adds no number of its own. No tab shell — a standalone inventory route,
 * like Blocking and Movement — and the navbar owns the title, so nothing is rendered here.
 *
 * `?grade=<code>` selects the tab: deep-linkable, refresh-safe, and a value naming no
 * grade resolves to the first active one rather than half-selecting anything. The
 * `<Suspense>` boundary is required because `ProductsView` reads `useSearchParams`.
 *
 * NO PRICE GATING. There is no ₱ column anywhere in the products schema and none is
 * derivable from it, so `canViewPrices()` is deliberately not imported and every figure
 * on this page is visible to every role including Production.
 */
export default async function ProductsPage({
    searchParams,
}: {
    searchParams: Promise<{ grade?: string }>;
}) {
    const { grade } = await searchParams;
    const data = await getProductsData(grade);

    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center">
                    <Loader2 className="size-8 animate-spin text-muted-foreground" />
                </div>
            }
        >
            <ProductsView data={data} />
        </Suspense>
    );
}
