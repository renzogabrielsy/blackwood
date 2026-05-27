'use client';

import { Card, CardContent } from '@/components/ui/card';
import { ProductionSheetTabs } from './components/sheet-tabs';
import { ProductionTabProvider } from './components/production-tab-context';

export default function ProductionLayout({ children }: { children: React.ReactNode }) {
    return (
        <ProductionTabProvider>
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-muted/20">
                <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6">
                    <Card className="h-full flex flex-col gap-0 py-0 border-none shadow-xl">
                        <CardContent className="flex-1 min-h-0 p-2 md:p-4 flex flex-col relative">
                            {children}
                        </CardContent>
                        <ProductionSheetTabs />
                    </Card>
                </div>
            </div>
        </ProductionTabProvider>
    );
}
