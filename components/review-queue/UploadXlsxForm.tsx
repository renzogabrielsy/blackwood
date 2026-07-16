'use client'

import * as React from 'react'
import { Loader2, Upload, X } from 'lucide-react'

import { errorToast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

import { uploadForReview } from '@/app/(app)/review-queue/actions'

interface UploadXlsxFormProps {
    onUploaded: (summary: {
        newCount: number
        changedCount: number
        noopCount: number
    }) => void
}

// Phase A ships with just one report type, but built as a select so adding
// more is a one-line change.
const REPORT_TYPES: { value: string; label: string }[] = [
    { value: 'rc_deliveries', label: 'RC DELIVERIES (deliveries)' },
]

export function UploadXlsxForm({ onUploaded }: UploadXlsxFormProps) {
    const [file, setFile] = React.useState<File | null>(null)
    const [reportType, setReportType] = React.useState<string>(REPORT_TYPES[0].value)
    const [submitting, setSubmitting] = React.useState(false)
    const fileInputRef = React.useRef<HTMLInputElement | null>(null)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!file || submitting) return

        setSubmitting(true)
        try {
            const fd = new FormData()
            fd.append('file', file)
            fd.append('reportType', reportType)
            const result = await uploadForReview(fd)
            onUploaded({
                newCount: result.newCount,
                changedCount: result.changedCount,
                noopCount: result.noopCount,
            })
            // Reset on success
            setFile(null)
            if (fileInputRef.current) fileInputRef.current.value = ''
        } catch (err) {
            errorToast(
                err instanceof Error ? err.message : 'Upload failed',
                { description: 'The file was not processed. Check the format and try again.' }
            )
        } finally {
            setSubmitting(false)
        }
    }

    const handleClearFile = () => {
        setFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    return (
        <Card className="p-4">
            <form
                onSubmit={handleSubmit}
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
                {/* File picker */}
                <div className="flex-1 min-w-0 space-y-1.5">
                    <Label htmlFor="xlsx-file" className="text-xs">
                        Daily report file
                    </Label>
                    <div className="relative">
                        <input
                            ref={fileInputRef}
                            id="xlsx-file"
                            type="file"
                            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                            disabled={submitting}
                            className={cn(
                                'block w-full text-xs text-muted-foreground',
                                'file:mr-3 file:rounded-md file:border-0 file:bg-muted',
                                'file:px-3 file:py-1.5 file:text-xs file:font-medium',
                                'file:text-foreground hover:file:bg-muted/80',
                                'file:cursor-pointer cursor-pointer',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                'rounded-md border border-input bg-background',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                                'transition-shadow'
                            )}
                        />
                        {file && (
                            <button
                                type="button"
                                onClick={handleClearFile}
                                disabled={submitting}
                                className={cn(
                                    'absolute right-2 top-1/2 -translate-y-1/2',
                                    'rounded-sm p-0.5 text-muted-foreground/70',
                                    'hover:text-foreground hover:bg-muted transition-colors',
                                    'disabled:opacity-50'
                                )}
                                aria-label="Clear file"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Report type select */}
                <div className="sm:w-[260px] space-y-1.5">
                    <Label htmlFor="report-type" className="text-xs">
                        Report type
                    </Label>
                    <Select
                        value={reportType}
                        onValueChange={setReportType}
                        disabled={submitting}
                    >
                        <SelectTrigger id="report-type" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {REPORT_TYPES.map((rt) => (
                                <SelectItem key={rt.value} value={rt.value}>
                                    {rt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Submit */}
                <Button
                    type="submit"
                    disabled={!file || submitting}
                    className="sm:w-auto gap-2"
                >
                    {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Upload className="h-4 w-4" />
                    )}
                    {submitting ? 'Processing…' : 'Upload & classify'}
                </Button>
            </form>
        </Card>
    )
}
