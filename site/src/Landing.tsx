import * as css from "./Landing.css.js";

const features = [
    {
        icon: "🌳",
        title: "File-Based Routing",
        desc: "Define your entire app as a route tree in routes.tsx. Nested layouts, automatic path resolution, and middleware inheritance.",
    },
    {
        icon: "⚡",
        title: "SSR + Hydration",
        desc: "Server-side rendering with seamless client hydration. Loaders run in parallel on the server, data flows automatically.",
    },
    {
        icon: "🔄",
        title: "RPC Actions",
        desc: "Write server functions, call them from the client. The Vite plugin transforms action bodies into fetch stubs via AST.",
    },
    {
        icon: "📡",
        title: "Reactive Signals",
        desc: "@preact/signals for fine-grained reactivity. No re-renders, no selectors — just signals that update the DOM directly.",
    },
    {
        icon: "📦",
        title: "Zero Config",
        desc: "One plugin, one install. Hono, Preact, Vite, wouter — everything included and wired together out of the box.",
    },
    {
        icon: "🔒",
        title: "Type-Safe",
        desc: "Full TypeScript. Typed loaders, actions, route modules, and middleware. Autocomplete everywhere.",
    },
];

export function Landing() {
    return (
        <div class={css.page}>
            {/* Nav */}
            <nav class={css.nav}>
                <div class={css.navInner}>
                    <span class={css.logo}>VeloJS</span>
                    <div class={css.navLinks}>
                        <a href="#/docs/getting-started" class={css.navLink}>Docs</a>
                        <a href="https://github.com/mauro-andre/velojs" target="_blank" class={css.navLink}>GitHub</a>
                        <a href="https://www.npmjs.com/package/@mauroandre/velojs" target="_blank" class={css.navLink}>npm</a>
                        <a href="#/docs/getting-started" class={css.navCta}>Get Started</a>
                    </div>
                </div>
            </nav>

            {/* Hero */}
            <section class={css.hero}>
                <h1 class={css.heroTitle}>VeloJS</h1>
                <p class={css.heroTagline}>Fullstack web framework that just works</p>
                <p class={css.heroSubtitle}>
                    Hono + Preact + Vite. Server-side rendering, client hydration, RPC actions,
                    nested routing — everything wired together with a single plugin.
                </p>
                <div class={css.heroActions}>
                    <a href="#/docs/getting-started" class={css.btnPrimary}>Get Started</a>
                    <a href="https://github.com/mauro-andre/velojs" target="_blank" class={css.btnSecondary}>View on GitHub</a>
                </div>
            </section>

            {/* Install */}
            <section class={css.installSection}>
                <h2 class={css.sectionTitle}>Get started in seconds</h2>
                <code class={css.installCode}>npx @mauroandre/velojs init my-app</code>
            </section>

            {/* Features */}
            <section class={css.section}>
                <h2 class={css.sectionTitle}>Everything you need</h2>
                <p class={css.sectionSubtitle}>
                    An opinionated fullstack framework that handles routing, SSR, state, and builds — so you can focus on your app.
                </p>
                <div class={css.featuresGrid}>
                    {features.map((f, i) => (
                        <div key={i} class={css.featureCard}>
                            <span class={css.featureIcon}>{f.icon}</span>
                            <h3 class={css.featureTitle}>{f.title}</h3>
                            <p class={css.featureDesc}>{f.desc}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* Footer */}
            <footer class={css.footer}>
                <div class={css.footerInner}>
                    <span class={css.logo}>VeloJS</span>
                    <div class={css.footerLinks}>
                        <a href="#/docs/getting-started" class={css.footerLink}>Docs</a>
                        <a href="https://github.com/mauro-andre/velojs" target="_blank" class={css.footerLink}>GitHub</a>
                        <a href="https://www.npmjs.com/package/@mauroandre/velojs" target="_blank" class={css.footerLink}>npm</a>
                    </div>
                    <p class={css.footerCopyright}>&copy; {new Date().getFullYear()} Mauro André Silva. MIT License.</p>
                </div>
            </footer>
        </div>
    );
}
