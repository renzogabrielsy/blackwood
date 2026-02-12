import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getAuditLogEntry, getAuditComments } from '../../actions';
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
    <div className="flex flex-col h-screen overflow-hidden">
      <div className="flex-none px-4 pt-3 pb-2">
        <Link
          href="/rc-in"
          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors w-fit"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to RC IN
        </Link>
      </div>

      <div className="flex-1 min-h-0 px-4 pb-3">
        <EditDiscussion
          log={result.log}
          delivery={result.delivery}
          initialComments={comments}
        />
      </div>
    </div>
  );
}
