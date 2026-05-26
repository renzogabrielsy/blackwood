import { redirect } from 'next/navigation';

/**
 * RC Movement is rendered as a tab inside /inventory (the Movement tab).
 * Visiting /inventory/rc-movement directly redirects to the inventory page
 * with month/year params preserved if present.
 */
export default async function RcMovementPage({
    searchParams,
}: {
    searchParams: Promise<{ y?: string; m?: string }>;
}) {
    const { y, m } = await searchParams;
    const qs = new URLSearchParams();
    if (y) qs.set('y', y);
    if (m) qs.set('m', m);
    const tail = qs.toString();
    redirect('/inventory' + (tail ? '?' + tail : ''));
}
