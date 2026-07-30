// `/production` — the tab index. Inside the `(tabs)` route group (URL-invisible),
// so it still resolves at `/production` but the shell it inherits no longer
// reaches `/production/schedule`.
import { ProductionView } from '../components/production-view';

export default function ProductionPage() {
    return <ProductionView />;
}
