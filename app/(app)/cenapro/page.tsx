import Link from 'next/link';
import { Factory, Boxes, ArrowRight, FlaskConical, ChartNoAxesCombined, Truck } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

// Cenapro landing — a small hub linking to the two screens.
// Cenapro is the platform's second tenant (the CI / Cebu charcoal company),
// fully decoupled from the ICTC / Davao tenant. Both screens are EDITABLE:
// the app itself is now the maintaining system of record for the `cenapro`
// schema (production events + opening balances are entered/edited in-app),
// having been seeded from the original .xlsb workbook.
export default function CenaproLandingPage() {
    return (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 md:p-10">
            <div className="mx-auto max-w-4xl">
                <div className="mb-6 animate-fade-up">
                    <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Tenant #2 · Cebu (CI)
                        </span>
                    </div>
                    <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                        Editable production &amp; inventory screens for Cenapro. The app is now the system of
                        record for the <code className="font-mono text-xs">cenapro</code> schema — events and
                        opening balances are entered and edited here, seeded from the original{' '}
                        <code className="font-mono text-xs">.xlsb</code> workbook.
                    </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 stagger-children">
                    <Link href="/cenapro/production" className="group block">
                        <Card className="hover-lift h-full border-border transition-colors group-hover:border-primary/40">
                            <CardContent className="flex h-full flex-col gap-3 p-5">
                                <div className="flex items-center justify-between">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                                        <Factory className="h-5 w-5" />
                                    </div>
                                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold">Production</h2>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Every production event — bagging and partner draws (crushers, kilns) — in a
                                        dense, filterable ledger.
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>

                    <Link href="/cenapro/inventory" className="group block">
                        <Card className="hover-lift h-full border-border transition-colors group-hover:border-primary/40">
                            <CardContent className="flex h-full flex-col gap-3 p-5">
                                <div className="flex items-center justify-between">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                                        <Boxes className="h-5 w-5" />
                                    </div>
                                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold">Flec Inventory</h2>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Per-warehouse flec-count balances by grade and side, with a movement ledger
                                        that shows the running math.
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>

                    <Link href="/cenapro/deliveries" className="group block">
                        <Card className="hover-lift h-full border-border transition-colors group-hover:border-primary/40">
                            <CardContent className="flex h-full flex-col gap-3 p-5">
                                <div className="flex items-center justify-between">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                                        <Truck className="h-5 w-5" />
                                    </div>
                                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold">RC Deliveries</h2>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Every raw-charcoal receipt — truck, supplier, weight, lab panel and price —
                                        as the operators&rsquo; own RC sheet, with the arithmetic cells intact.
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>

                    <Link href="/cenapro/qc" className="group block">
                        <Card className="hover-lift h-full border-border transition-colors group-hover:border-primary/40">
                            <CardContent className="flex h-full flex-col gap-3 p-5">
                                <div className="flex items-center justify-between">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                                        <FlaskConical className="h-5 w-5" />
                                    </div>
                                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold">QC Ledger</h2>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Log CCC&rsquo;s partner lab results — BD, ASH, GRIT, MC — straight onto the
                                        receipts, one reading per source &amp; warehouse per day.
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>

                    <Link href="/cenapro/qc/breakdown" className="group block">
                        <Card className="hover-lift h-full border-border transition-colors group-hover:border-primary/40">
                            <CardContent className="flex h-full flex-col gap-3 p-5">
                                <div className="flex items-center justify-between">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                                        <ChartNoAxesCombined className="h-5 w-5" />
                                    </div>
                                    <ArrowRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                                </div>
                                <div>
                                    <h2 className="text-base font-semibold">QC Breakdown</h2>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Weighted BD / ASH / GRIT / MC by month and by day, with tonnage and sample
                                        coverage. Read-only, ex-DVO.
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </Link>
                </div>
            </div>
        </div>
    );
}
