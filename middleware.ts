import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Use getUser() instead of getSession() — validates the JWT server-side
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Public paths that don't require authentication. The PWA manifest + icon
  // routes MUST be public — the browser fetches them before login (to offer
  // "Add to Home Screen"), and iOS fetches apple-icon with no session.
  const PUBLIC_PATHS = [
    '/login',
    '/auth',
    '/access-denied',
    '/api',
    '/manifest.webmanifest',
    '/icon',
    '/apple-icon',
  ]

  // The Blackwood Table playground (`/dev/table-playground`) is a rendering fixture with
  // NO data access of any kind — it mounts the shared grid on an in-memory array — and it
  // exists so the Playwright parity suite can drive the real component without holding
  // real credentials. It is public ONLY where it is meant to run: outside production, or
  // in production with `TABLE_PLAYGROUND` explicitly set. The page itself carries the
  // identical condition and 404s, so the two locks are independent and either one alone
  // keeps it off the live site.
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.TABLE_PLAYGROUND
  ) {
    PUBLIC_PATHS.push('/dev/table-playground')
  }

  const isPublic = PUBLIC_PATHS.some((p) =>
    request.nextUrl.pathname.startsWith(p)
  )

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Always return supabaseResponse so refreshed cookies are forwarded
  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
