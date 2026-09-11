---
description: "Load localStorage/cookies BEFORE the first paint with `<Boot>` in client-root and read them with `useBoot()` — flicker-free themes, sidebars, and layout preferences. Use when UI state from the browser flashes on reload or when persisting layout preferences."
---

# Boot state (pre-paint loading)

State stored in the browser (theme, collapsed sidebar, panel sizes) causes a flash on reload: the SSR HTML paints with defaults, then client JS corrects it — one visible frame of the wrong layout. The only code that runs between the `<head>` being parsed and the `<body>` being painted is a **synchronous inline script in the head**. `<Boot>` generates that script for you.

## Declaring what to load

In `client-root.tsx`, declare each storage separately with the exact key names your app uses:

```tsx
import { Boot, Scripts } from "@mauroandre/velojs";

export const Component = ({ children }) => (
    <html>
        <head>
            <Boot localStorage={["theme", "sidebarHidden"]} />
            <Boot cookies={["org"]} />
        </head>
        <body>
            {children}
            <Scripts />
        </body>
    </html>
);
```

The generated script runs before the first paint and does two things:

1. Populates `window.__VELO_BOOT__ = { theme: "dark", sidebarHidden: "true" }` — only keys that exist; absent keys stay out.
2. Mirrors each found key as a sanitized `data-*` attribute on `<html>`: `data-theme="dark"`, `data-sidebar-hidden`... Key sanitization: anything outside `[a-zA-Z0-9-]` becomes `-` — `"bc:terminal-colapsado"` → `data-bc-terminal-colapsado`.

## Reading

```tsx
import { useBoot } from "@mauroandre/velojs/hooks";

const { theme, sidebarHidden } = useBoot();
```

Values are **raw strings**, immutable by definition — the boot happened once. Seed your own signal with them for reactivity (`signal(boot.sidebarHidden === "true")`); parse numbers/JSON yourself.

On the server `useBoot()` returns `{}` — SSR always renders defaults, never touches `window`.

## The anti-flicker contract (the part that matters)

**Visual state must be CSS reacting to the mirrored data-attribute — never conditional JSX.**

```css
html[data-theme="dark"] { --color-surface: #11151f; }
html[data-sidebar-hidden="true"] .sidebar { display: none; }
```

- ✅ Always render the sidebar in the vdom; hide it with CSS on the attribute. The attribute is correct **before the first paint** → single correct paint, no flash, no hydration mismatch.
- ❌ `{!sidebarHidden && <Sidebar />}` — the client's first render diverges from the SSR DOM (hydration mismatch) and only corrects **after** paint: the flash is back.

A CSS `transition` on the mirrored property does not fire on load (the attribute is set before the first style computation) — transitions only run on interactive toggles, which is what you want.

## Writing is the app's business

`<Boot>` only loads. Persisting on change is a signal + storage write in your gestures:

```tsx
const sidebarHidden = signal(/* seeded from useBoot */);
useEffect(() => {
    document.documentElement.dataset.sidebarHidden = String(sidebarHidden.value);
    localStorage.setItem("sidebarHidden", String(sidebarHidden.value));
}, [sidebarHidden.value]);
```

## Reference

| Piece | Behavior |
|-------|----------|
| `<Boot localStorage={[...]} />` | Inline pre-paint script; one `<Boot>` per storage |
| `<Boot cookies={[...]} />` | Same, from `document.cookie` |
| `useBoot()` | `Record<string, string>` — `{}` on the server, boot values on the client |
| Key `a:b` in storage | Attribute `data-a-b`; object key stays `"a:b"` |
| Storage throws (private mode) | Script is a no-op — app renders defaults |
