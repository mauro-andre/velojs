# Scripts Component

The `Scripts` component injects the CSS and JavaScript files that your app needs. It must be placed inside `<head>` in your `client-root.tsx`.

## Usage

```tsx
import { Scripts } from "@mauroandre/velojs";

export const Component = ({ children }) => (
    <html>
        <head>
            <Scripts />
        </head>
        <body>{children}</body>
    </html>
);
```

## What it outputs

`Scripts` automatically detects whether you're in development or production mode and outputs the appropriate tags.

**In development:**
```html
<link rel="icon" href="/favicon.ico" type="image/x-icon" />
<script type="module" src="/@vite/client"></script>
<script type="module" src="/__velo_client.js"></script>
```

**In production:**
```html
<link rel="icon" href="/favicon.ico" type="image/x-icon" />
<link rel="stylesheet" href="/client.C3f9Ax_1.css" />
<script type="module" src="/client.C3f9Ax_1.js"></script>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `basePath` | `string` | `""` | Base path prefix for all asset URLs. Uses `STATIC_BASE_URL` env var if set. |
| `favicon` | `string \| false` | `"/favicon.ico"` | Path to the favicon. Set to `false` to disable. |

## Using with a CDN

If you serve static assets from a CDN or S3 bucket, set the `STATIC_BASE_URL` environment variable. The `Scripts` component will automatically prefix all asset URLs:

```bash
STATIC_BASE_URL=https://cdn.example.com/assets velojs start
```

This makes the output become:
```html
<link rel="stylesheet" href="https://cdn.example.com/assets/client.C3f9Ax_1.css" />
<script type="module" src="https://cdn.example.com/assets/client.C3f9Ax_1.js"></script>
```
