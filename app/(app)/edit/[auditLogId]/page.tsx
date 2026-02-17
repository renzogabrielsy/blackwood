import { notFound } from 'next/navigation';
import { getAuditLogEntry, getAuditComments } from '@/app/(app)/inventory/rc-in/actions';
import { EditDiscussion } from './edit-discussion';

export default async function EditDiscussionPage({
  params,
}: {
  params: Promise<{ auditLogId: string }>;
}) {
  const { auditLogId } = await params;
  const result = await getAuditLogEntry(auditLogId);

  if (!result.success) {
    notFound();
  }

  const comments = await getAuditComments(auditLogId);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 px-4 py-3 overflow-hidden">
        <EditDiscussion
          log={result.log}
          delivery={result.delivery}
          initialComments={comments}
        />
      </div>
    </div>
  );
}
