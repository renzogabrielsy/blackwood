import { Card } from '@/components/ui/card';

// Cenapro module shell — a Card frame matching the Production module's look.
// Unlike Production, Cenapro's two screens each own their own controls (the
// Production table owns its header filters; the Flec Inventory page owns its
// warehouse + start-date pickers), so there is no shared period provider here.
export default function CenaproLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/20">
            <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
                <Card className="h-full flex flex-col gap-0 py-0 border-none shadow-xl overflow-hidden">
                    {children}
                </Card>
            </div>
        </div>
    );
}
