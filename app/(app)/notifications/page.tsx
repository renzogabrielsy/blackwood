import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell } from 'lucide-react';

export default function NotificationsPage() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-3">
            <Bell className="h-10 w-10 text-muted-foreground opacity-40" />
          </div>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-sm text-muted-foreground">
            Full notification history with filters and bulk actions — coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
