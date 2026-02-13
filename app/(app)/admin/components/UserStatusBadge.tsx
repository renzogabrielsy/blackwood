'use client';

import { Badge } from '@/components/ui/badge';

interface UserStatusBadgeProps {
  status: string;
}

export function UserStatusBadge({ status }: UserStatusBadgeProps) {
  if (status === 'disabled') {
    return (
      <Badge variant="destructive" className="text-xs">
        Disabled
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200">
      Active
    </Badge>
  );
}
