# Static Site Generation (SSG)

VeloJS can generate fully static HTML sites — perfect for landing pages, documentation, blogs, and any content that doesn't change per request. Static sites are fast, cheap to host, and excellent for SEO since search engines see the complete HTML.

## How it works

When you run `velojs build --static`, VeloJS:

1. Builds the client bundle (JS, CSS) — same as a normal build
2. Builds the server entry — same as a normal build
3. **Crawls every route** in your app, runs the loaders, and renders the HTML
4. Saves two files per route:
   - `index.html` — the complete pre-rendered page (what search engines see)
   - `index.json` — the loader data (used for SPA-like navigation between pages)

The result is a `dist/` folder with pure HTML + assets that you can deploy to any static hosting (CDN, S3, GitHub Pages, Netlify, etc).

## Quick start

Build your app as a static site:

```bash
npx velojs build --static
```

The output:

```
dist/
├── index.html              # Home page
├── index.json              # Home page data
├── 404.html                # Catch-all page (if defined) — see Custom 404 page
├── about/
│   ├── index.html          # About page
│   └── index.json          # About page data
├── docs/
│   ├── getting-started/
│   │   ├── index.html
│   │   └── index.json
│   └── routes/
│       ├── index.html
│       └── index.json
└── client/
    ├── client.C3f9Ax_1.js   # Client bundle (content-hashed)
    └── client.C3f9Ax_1.css  # Styles (content-hashed)
```

## SPA-like navigation

Even though the site is static, navigation between pages feels instant — no full page reloads. Here's how:

1. **First visit**: the browser loads the pre-rendered `index.html` (fast, SEO-friendly)
2. **Subsequent clicks**: JavaScript fetches the `index.json` for the target page and updates the UI without reloading

This gives you the best of both worlds: static HTML for SEO and performance, with SPA-like transitions for the user experience.

## Loaders in static mode

Loaders work normally — they run once during the build and their data is frozen into the HTML and JSON files. This is perfect for:

- Fetching content from a CMS or API at build time
- Reading markdown files from disk
- Any data that doesn't change per user or per request

```typescript
export const loader = async () => {
    // This runs once during `velojs build --static`
    const { getPostsFromCMS } = await import("./cms.service.js");
    return getPostsFromCMS();
};
```

The data returned by the loader is embedded in the page's HTML (for SEO) and also saved as a JSON file (for SPA navigation).

## Dynamic routes with staticPaths

Routes with URL parameters (like `/users/:id`) can't be pre-rendered without knowing all possible values. Export a `staticPaths` function to tell VeloJS which pages to generate:

```typescript
// app/pages/UserDetail.tsx

export const staticPaths = async () => {
    const { getUsers } = await import("./user.service.js");
    const users = await getUsers();
    return users.map(u => ({ id: u.id }));
};

// This generates:
// /users/1/index.html
// /users/2/index.html
// /users/3/index.html
// ... one page per user

export const loader = async ({ params }: LoaderArgs) => {
    const { getUser } = await import("./user.service.js");
    return getUser(params.id);
};

export const Component = () => {
    const { data } = useLoader<User>();
    return <h1>{data.value?.name}</h1>;
};
```

Routes with `:params` that don't export `staticPaths` are skipped during the static build (with a warning).

## Custom 404 page

If your app defines a catch-all route (`{ path: "*", module: NotFound }` — see [Routes](/docs/routes#the-404-page)), the static build emits it as **`dist/404.html`** at the output root, following the universal `/404.html` convention.

Most static hosts serve `404.html` automatically for unmatched paths (GitHub Pages, Netlify, Cloudflare Pages, S3/CloudFront). On a bare nginx you point `error_page 404 /404.html;` at it. The HTTP status on a direct hit is then up to the host — in static mode VeloJS only produces the page content, not the response status.

## What doesn't work in static mode

Since there's no server running after the build, some features are not available:

| Feature | Status | Why |
|---------|--------|-----|
| `Component` | Works | Pre-rendered to HTML |
| `loader` | Works | Runs once at build time, data frozen |
| `useLoader` / `Loader` | Works | Hydrates from HTML, SPA nav via JSON |
| `Link` | Works | SPA navigation without reload |
| `useParams`, `useQuery` | Works | Read from URL at runtime |
| `action_*` | Not available | No server to handle POST requests |
| `middlewares` | Not available | No per-request server context |
| `addRoutes` / `onServer` | Not available | No server running |
| `getCookie` / `setCookie` | Not available | No request/response context |
| SSE / WebSocket | Not available | No server for real-time connections |

**Rule of thumb**: if your page only displays data (no forms, no mutations, no auth), it works perfectly as static. If it needs server interaction at runtime, use the normal SSR build (`velojs build` without `--static`).

## Deployment

The `dist/` folder is a self-contained static site. Deploy it anywhere:

```bash
# Any static file server
npx serve dist

# Or upload to S3, Netlify, Vercel, GitHub Pages, etc.
```

No Node.js server needed in production.
