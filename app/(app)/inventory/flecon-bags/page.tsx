// No 'use client' — async Server Component. Fetches FLECON bag inventory data
// and hands it to the client view. The navbar owns the page title/description,
// so no header is rendered here (project rule). Thin by design — the view owns
// the container and all interactivity.
import { fetchFleconBagData } from './actions';
import { FleconBagsView } from './components/flecon-bags-view';

export default async function FleconBagsPage() {
    const { balances, movements, error } = await fetchFleconBagData();

    return <FleconBagsView balances={balances} movements={movements} error={error} />;
}
