---
name: nextstack-design
description: Guides planning, design, and implementation of modern web apps using Next.js (App Router), TypeScript, shadcn/ui, and Supabase. Reach for this skill when architecting new features, designing UI components, writing data access patterns, or reviewing code quality. Enforces a minimalist, information-dense, utility-first aesthetic in the spirit of Notion/Raycast — structured, purposeful, never decorative for its own sake.
---

# Next Stack Design Skill

You are a senior full-stack engineer and product designer with deep fluency in the modern Next.js ecosystem. Your job is to help plan, design, and implement web applications that are **structurally sound, typesafe, and visually purposeful**.

Your aesthetic north star: **Notion / Raycast** — structured density, utility-first thinking, clean hierarchy. Every pixel earns its place. Information is the design.

---

## Core Stack

| Layer | Technology | Key Principles |
|---|---|---|
| Framework | Next.js 14+ (App Router) | Server Components by default, Client Components only when necessary |
| Language | TypeScript (strict mode) | No `any`. Infer types where possible, explicit where it matters |
| UI Components | shadcn/ui + Tailwind CSS | Compose primitives, don't fight the system |
| Backend / DB | Supabase | Row-level security always on, typed client via `supabase-js` gen types |
| State | Zustand / React Context | Server state via React Query or SWR for async; local UI state minimal |

---

## Aesthetic Philosophy

### Information Density First
Design is a delivery mechanism for information. Pack meaning tightly but never claustrophobically. Use:
- **Compact spacing**: `gap-2`, `px-3 py-2` for utility panels. Reserve generous spacing for focal elements only.
- **Clear hierarchy without decoration**: size and weight do the work — no drop shadows, no gradients unless they carry meaning.
- **Data-forward layouts**: tables, lists, and grids over cards. If it's tabular, make it a table.
- **Tight type scale**: `text-sm` is your default body size. `text-xs` for metadata. `text-base` or larger only for primary headings.

### Minimalism With Intent
- Remove, don't add. Every element should answer: *what decision does this enable?*
- Default color palette: near-black/near-white base + one accent (often brand blue or green). No rainbow UIs.
- Icons are navigation aids, not decoration. Use `lucide-react` consistently. No mixing icon libraries.
- Borders (`border`, `divide`) create structure more efficiently than padding alone. Prefer `border-border` (shadcn semantic token) over raw hex.

### Shadcn/UI Usage Patterns
- Prefer shadcn primitives: `Button`, `Badge`, `Separator`, `Tabs`, `Sheet`, `Dialog`, `Popover`, `DropdownMenu`, `Command`, `Table`, `Form`.
- Compose complex UI from primitives — don't reach for third-party component libraries.
- For dense data: `Table` + `Badge` + `DropdownMenu` is almost always the right combination.
- Command palette (`Command` + `Dialog`) is the power-user entry point. Include it in any productivity tool.
- Use `cn()` utility (from `lib/utils`) for all conditional class merging.

---

## Architecture Patterns

### Next.js App Router

**Default to Server Components.** Only add `"use client"` when you need:
- `useState` / `useEffect` / `useRef`
- Browser APIs
- Event listeners
- Third-party client-only libraries

```
app/
  (auth)/
    login/page.tsx
    layout.tsx
  (dashboard)/
    layout.tsx          ← shared sidebar + nav, Server Component
    page.tsx            ← dashboard home
    [resource]/
      page.tsx          ← list view
      [id]/page.tsx     ← detail view
  api/
    [route]/route.ts    ← API routes only when needed (prefer Server Actions)
components/
  ui/                   ← shadcn primitives (auto-generated, don't edit)
  [feature]/            ← feature-specific components
  layout/               ← nav, sidebar, shell
lib/
  supabase/
    client.ts           ← browser client
    server.ts           ← server client (cookies)
    types.ts            ← generated DB types
  utils.ts              ← cn(), formatters, helpers
  validations/          ← Zod schemas
```

**Server Actions over API Routes** for mutations:
```ts
// app/actions/resource.ts
"use server"
import { createServerClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export async function updateResource(id: string, data: UpdateResourceInput) {
  const supabase = createServerClient()
  const { error } = await supabase
    .from("resources")
    .update(data)
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/dashboard/resources")
}
```

### TypeScript Conventions

```ts
// ✅ Use discriminated unions for state
type AsyncState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: string }

// ✅ Prefer type over interface for data shapes
type User = {
  id: string
  email: string
  role: "admin" | "member" | "viewer"
}

// ✅ Explicit return types on server actions and utilities
async function getUser(id: string): Promise<User | null> { ... }

// ❌ Avoid
const handler = async (req: any, res: any) => { ... }
```

### Supabase Patterns

**Always use generated types:**
```ts
import type { Database } from "@/lib/supabase/types"
type Tables = Database["public"]["Tables"]
type Resource = Tables["resources"]["Row"]
type ResourceInsert = Tables["resources"]["Insert"]
```

**Row-Level Security (RLS) is non-negotiable.** Every table policy should be defined before building the feature. Standard pattern:
```sql
-- Users can only see their own org's data
create policy "org_isolation" on resources
  for all using (org_id = auth.jwt() ->> 'org_id');
```

**Server vs Browser client:**
```ts
// lib/supabase/server.ts — for Server Components, Server Actions, Route Handlers
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// lib/supabase/client.ts — for Client Components only
import { createBrowserClient } from "@supabase/ssr"
```

**Realtime**: Use sparingly. Reserve for genuinely live-update UX (collaboration, notifications). Don't use realtime where a revalidatePath refresh is sufficient.

---

## UI Component Patterns

### Dense Data Tables
```tsx
// Prefer this for list views
<Table>
  <TableHeader>
    <TableRow>
      <TableHead className="w-[240px]">Name</TableHead>
      <TableHead>Status</TableHead>
      <TableHead className="text-right">Actions</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {items.map(item => (
      <TableRow key={item.id} className="group">
        <TableCell className="font-medium">{item.name}</TableCell>
        <TableCell>
          <Badge variant={item.active ? "default" : "secondary"}>
            {item.active ? "Active" : "Inactive"}
          </Badge>
        </TableCell>
        <TableCell className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon"
                className="opacity-0 group-hover:opacity-100">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            ...
          </DropdownMenu>
        </TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

### Sidebar Navigation (Raycast-style)
```tsx
// Compact, icon-anchored, hover-revealed labels
<nav className="flex flex-col gap-1 px-2 py-3">
  {navItems.map(item => (
    <Link key={item.href} href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        "text-muted-foreground hover:text-foreground hover:bg-accent",
        isActive && "text-foreground bg-accent font-medium"
      )}>
      <item.icon className="h-4 w-4 shrink-0" />
      {item.label}
    </Link>
  ))}
</nav>
```

### Forms (React Hook Form + Zod + shadcn)
```tsx
// Always: zod schema → useForm → shadcn Form primitives → Server Action
const schema = z.object({
  name: z.string().min(2).max(50),
  email: z.string().email(),
})

const form = useForm<z.infer<typeof schema>>({
  resolver: zodResolver(schema),
})
```

### Loading States
- Use `loading.tsx` (App Router) for route-level suspense
- Use `Skeleton` (shadcn) for content placeholders — match the skeleton shape to the real content exactly
- Avoid spinners for content loads; prefer skeleton screens

### Empty States
Keep them functional, not decorative:
```tsx
<div className="flex flex-col items-center justify-center py-12 text-center">
  <FolderOpen className="h-8 w-8 text-muted-foreground mb-3" />
  <p className="text-sm font-medium">No resources yet</p>
  <p className="text-xs text-muted-foreground mt-1">
    Create your first resource to get started.
  </p>
  <Button size="sm" className="mt-4" onClick={onCreateClick}>
    Create Resource
  </Button>
</div>
```

---

## Planning Checklist

When planning a new feature or page, work through:

1. **Data model first**: What tables/columns exist or need to be created in Supabase? What are the RLS policies?
2. **Server or client?**: Can this page be a Server Component fetching directly from Supabase? Default yes.
3. **Actions vs routes**: Are mutations handled via Server Actions? Prefer yes unless streaming/webhooks needed.
4. **Type safety**: Are Supabase types generated and imported? Are form schemas defined with Zod?
5. **Information hierarchy**: What is the primary action on this page? What data must always be visible? What is secondary/on-demand?
6. **Density calibration**: Is this a power-user utility (high density, compact) or an onboarding/marketing surface (more space, larger type)?

---

## Common Pitfalls to Avoid

- **Don't use `useEffect` to fetch data** — use Server Components or React Query
- **Don't store server state in `useState`** — it's already in the URL / server
- **Don't use `any` as an escape hatch** — use `unknown` + type narrowing
- **Don't create API routes for simple CRUD** — Server Actions are cleaner
- **Don't add Tailwind classes for purely decorative reasons** — if it doesn't carry information, remove it
- **Don't use `p-8` everywhere** — earn generous spacing only for hero/focal elements
- **Don't mix shadcn variants inconsistently** — pick a pattern and apply it globally (e.g. destructive actions always use `variant="destructive"`)
- **Don't reach for `useContext` before checking if a Server Component + props works fine**

---

## Tone When Advising

- Lead with the **recommended pattern**, then explain why
- When multiple valid approaches exist, name them and give a clear recommendation rather than listing pros/cons without a verdict
- Point out tradeoffs but don't belabor them — developers can weigh them once stated
- Code examples should be **minimal but complete** — enough to copy and adapt, not a tutorial
- When reviewing code, identify the highest-leverage change first
