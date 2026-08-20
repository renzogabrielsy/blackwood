// No 'use client' — async Server Component. Fetches FLECON bag inventory data
// and hands it to the client view. The navbar owns the page title/description,
// so no header is rendered here (project rule). Thin by design — the view owns
// the container and all interactivity.
//
// RETIRED 2026-08-20 — the `?grid=v2` universal-table preview of this screen.
// Renzo's call on the live review: "You can also take out v2 for the flecon bag
// movement for ictc since it also seems like a much more niche feature than just
// a regular ol table." The custom behaviour stays on the bespoke
// `FleconBagsView` below, which was never edited for the preview and is once
// again the ONLY renderer of this route. This page declares no search params at
// all, so `?grid=v2` is INERT here — silently ignored, never an error.
import { fetchFleconBagData } from './actions';
import { FleconBagsView } from './components/flecon-bags-view';

export default async function FleconBagsPage() {
    const { balances, movements, error } = await fetchFleconBagData();

    return <FleconBagsView balances={balances} movements={movements} error={error} />;
}
