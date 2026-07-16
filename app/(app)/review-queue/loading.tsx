import { Card } from '@/components/ui/card'

export default function ReviewQueueLoading() {
    return (
        <div className="flex-1 min-h-0 flex flex-col bg-muted/10">
            <div className="flex-1 min-h-0 px-4 md:px-6 py-4 md:py-6 overflow-auto">
                <div className="mx-auto w-full max-w-[1400px] space-y-4">
                    {/* Upload form skeleton */}
                    <Card className="p-4 animate-pulse">
                        <div className="flex items-end gap-3">
                            <div className="h-9 w-48 bg-muted rounded" />
                            <div className="h-9 w-56 bg-muted rounded" />
                            <div className="h-9 w-32 bg-muted rounded" />
                        </div>
                    </Card>

                    {/* List skeleton */}
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <Card key={i} className="p-4 animate-pulse space-y-3">
                                <div className="flex items-center gap-2">
                                    <div className="h-2 w-2 rounded-full bg-muted" />
                                    <div className="h-3 w-32 bg-muted rounded" />
                                </div>
                                <div className="h-4 w-3/4 bg-muted rounded" />
                                <div className="h-3 w-1/2 bg-muted rounded" />
                                <div className="flex gap-2">
                                    <div className="h-5 w-14 bg-muted rounded-full" />
                                    <div className="h-5 w-14 bg-muted rounded-full" />
                                </div>
                            </Card>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
