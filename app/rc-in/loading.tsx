import { Card, CardContent, CardHeader } from '@/components/ui/card';

export default function RCInLoading() {
    return (
        <div className="flex flex-col h-screen overflow-hidden bg-muted/10">
            <div className="flex-none p-4 md:p-6 pb-2">
                <div className="flex flex-row items-center justify-between">
                    <div className="space-y-2">
                        <div className="h-7 w-40 bg-muted animate-pulse rounded" />
                        <div className="h-4 w-56 bg-muted animate-pulse rounded" />
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 px-4 md:px-6 pb-4 md:pb-6">
                <Card className="h-full flex flex-col border-none shadow-sm">
                    <CardHeader className="p-0 hidden" />
                    <CardContent className="flex-1 min-h-0 p-0 flex flex-col relative">
                        <div className="flex-1 overflow-hidden rounded-md border bg-background">
                            {/* Header skeleton */}
                            <div className="h-8 bg-muted/50 border-b flex items-center gap-2 px-2">
                                {Array.from({ length: 12 }).map((_, i) => (
                                    <div key={i} className="h-3 bg-muted animate-pulse rounded flex-1" />
                                ))}
                            </div>
                            {/* Row skeletons */}
                            {Array.from({ length: 15 }).map((_, i) => (
                                <div key={i} className="h-8 border-b flex items-center gap-2 px-2">
                                    {Array.from({ length: 12 }).map((_, j) => (
                                        <div key={j} className="h-3 bg-muted/40 animate-pulse rounded flex-1" />
                                    ))}
                                </div>
                            ))}
                        </div>
                        <div className="flex-none flex justify-between items-center p-2 border-t bg-background rounded-b-lg">
                            <div className="h-4 w-48 bg-muted animate-pulse rounded" />
                            <div className="flex gap-2">
                                <div className="h-6 w-24 bg-muted animate-pulse rounded" />
                                <div className="h-6 w-24 bg-muted animate-pulse rounded" />
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
