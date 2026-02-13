import { Card } from '@/components/ui/card';

export default function AdminLoading() {
  return (
    <Card className="p-6">
      <div className="space-y-4 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-10 w-32 bg-muted rounded" />
        </div>
        <div className="h-[400px] w-full bg-muted rounded" />
      </div>
    </Card>
  );
}
