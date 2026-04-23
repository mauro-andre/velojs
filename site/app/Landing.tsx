import { Link } from "../../src/components.js";
import { useLoader } from "../../src/hooks.js";
import type { LoaderArgs } from "../../src/types.js";
import * as css from "./Landing.css.js";
import { Zap, CubeTransparent, Rss, Lock, Cog, Beaker } from "./icons/scarlab.js";
import { AmbientBackground } from "./components/AmbientBackground.js";
import { ComponentAnatomy } from "./components/ComponentAnatomy.js";
import { WritingShowcase } from "./components/WritingShowcase.js";
import { RoutesShowcase } from "./components/RoutesShowcase.js";
import { RealtimeShowcase } from "./components/RealtimeShowcase.js";
import { FeatureGrid, type Feature } from "./components/FeatureGrid.js";
import { CallToAction } from "./components/CallToAction.js";
import { highlight } from "./components/highlighted.js";

// ── Code snippets (highlighted at SSG build time via the `loader`) ──

const PRODUCTS_TSX = `// app/Products.tsx

// Runs on the server — fetches the products list
export const loader = async () => ({
    products: await db.products.findMany(),
});

// Toggle a product's active state on the server
export const action_toggleActiveProduct = async ({ body }) => {
    await db.products.toggleActive(body.id);
};

export const Component = () => {
    // Reads the products from the loader
    const { data } = useLoader();

    // Calls the server action for the given product id
    const toggle = (id) => action_toggleActiveProduct({ body: { id } });

    return (
        <ul>
            {data.value?.products.map(p => (
                <li key={p.id}>
                    {p.name}
                    <button onClick={() => toggle(p.id)}>Toggle</button>
                </li>
            ))}
        </ul>
    );
};`;

const ROUTES_TSX = `// app/routes.tsx

export default [{
    module: Root,
    isRoot: true,
    children: [
        { path: "/", module: Home },
        {
            path: "/app",
            middlewares: [authMiddleware],
            children: [
                { path: "/dashboard", module: Dashboard },
                { path: "/products", module: Products },
            ],
        },
        // Endpoint, not a page — handles GitHub webhooks
        {
            path: "/api/github",
            method: "POST",
            handler: githubWebhook,
        },
    ],
}];`;

const STREAM_TSX = `// app/Deploy.tsx

// Server pushes events through this stream
export const stream_progress = createEventStream<string>();

export const action_deploy = async () => {
    stream_progress.emit("Build complete");
    stream_progress.emit("Deploy live");
};

export const Component = () => {
    // Subscribes — updates reactively as events arrive
    const { data } = useEventStream(stream_progress);
    return <p>{data.value ?? "Waiting..."}</p>;
};`;

const SOCKET_TSX = `// app/Chat.tsx

// Bidirectional — both sides send and receive
export const socket_chat = async ({ incoming, send, keepOpen }) => {
    send({ from: "server", text: "Hi!" });
    keepOpen();

    // Server receives client messages, replies
    for await (const msg of incoming) {
        send({ from: "server", text: "Got: " + msg.text });
    }
};

export const Component = () => {
    // Receive via onMessage; send via the returned function
    const { send } = useSocket(socket_chat, {
        onMessage: (msg) => console.log(msg),
    });
    return <button onClick={() => send({ text: "Hi!" })}>Say Hi</button>;
};`;

interface LandingData {
    productsHtml: string;
    routesHtml: string;
    streamHtml: string;
    socketHtml: string;
}

export const loader = async (_args: LoaderArgs): Promise<LandingData> => {
    const [productsHtml, routesHtml, streamHtml, socketHtml] = await Promise.all([
        highlight(PRODUCTS_TSX, "tsx"),
        highlight(ROUTES_TSX, "tsx"),
        highlight(STREAM_TSX, "tsx"),
        highlight(SOCKET_TSX, "tsx"),
    ]);
    return { productsHtml, routesHtml, streamHtml, socketHtml };
};

const features: Feature[] = [
    {
        Icon: Zap,
        title: "Hybrid SSR + SPA",
        desc: "Server-rendered first paint, client-side navigation after. No opt-in flag — it's how the framework works.",
    },
    {
        Icon: CubeTransparent,
        title: "Static Generation",
        desc: "Same component, ship as static HTML. One CLI flag flips it: velojs build --static.",
    },
    {
        Icon: Rss,
        title: "Reactive Signals",
        desc: "@preact/signals baked in. Fine-grained updates, no virtual DOM thrash, no re-render storms.",
    },
    {
        Icon: Lock,
        title: "Type-Safe",
        desc: "Full TypeScript. Loaders, actions, middlewares — typed end to end. Autocomplete everywhere.",
    },
    {
        Icon: Cog,
        title: "Zero Config",
        desc: "One plugin, one install. Hono + Preact + Vite + wouter wired together out of the box.",
    },
    {
        Icon: Beaker,
        title: "Testing Built In",
        desc: "createTestApp() spins up your app in memory. HTTP, streams, sockets — all from one API.",
    },
];

export const Component = () => {
    const { data } = useLoader<LandingData>();
    return (
        <div class={css.page}>
            <AmbientBackground />

            {/* Nav */}
            <nav class={css.nav}>
                <div class={css.navInner}>
                    <span class={css.logo}>VeloJS</span>
                    <div class={css.navLinks}>
                        <Link to="/docs/getting-started" class={css.navLink}>Docs</Link>
                        <a href="https://github.com/mauro-andre/velojs" target="_blank" class={css.navLink}>GitHub</a>
                        <a href="https://www.npmjs.com/package/@mauroandre/velojs" target="_blank" class={css.navLink}>npm</a>
                        <Link to="/docs/getting-started" class={css.navCta}>Get Started</Link>
                    </div>
                </div>
            </nav>

            {/* Hero */}
            <section class={css.hero}>
                <span class={`${css.heroEyebrow} ${css.heroStep1}`}>VeloJS</span>
                <h1 class={`${css.heroTitle} ${css.heroStep2}`}>
                    <span class={css.heroTitleLine}>Full-stack TypeScript.</span>
                    <span class={css.heroTitleLine}>One mental model.</span>
                </h1>
                <p class={`${css.heroSubtitle} ${css.heroStep3}`}>
                    Build web apps where server and client share a codebase. Pages, APIs,
                    webhooks, and real-time — one framework, one language, one component.
                </p>
                <div class={`${css.heroActions} ${css.heroStep4}`}>
                    <Link to="/docs/getting-started" class={css.btnPrimary}>Get Started</Link>
                    <a
                        href="https://github.com/mauro-andre/velojs"
                        target="_blank"
                        class={css.btnSecondary}
                    >
                        View on GitHub
                    </a>
                </div>
                <ul class={`${css.heroPills} ${css.heroStep5}`} aria-label="What you build with VeloJS">
                    <li class={css.heroPill}>Pages</li>
                    <li class={css.heroPill}>Actions</li>
                    <li class={css.heroPill}>Webhooks</li>
                    <li class={css.heroPill}>Real-time</li>
                    <li class={css.heroPill}>Static sites</li>
                </ul>
            </section>

            {/* §2 — Anatomy of a VeloJS component */}
            <ComponentAnatomy />

            {/* §3 — Writing showcase (code in action) */}
            <WritingShowcase codeHtml={data.value?.productsHtml ?? ""} />

            {/* §4 — Routes showcase (code + tree + table) */}
            <RoutesShowcase codeHtml={data.value?.routesHtml ?? ""} />

            {/* §5 — Real-time (stream + socket tabbed) */}
            <RealtimeShowcase
                streamHtml={data.value?.streamHtml ?? ""}
                socketHtml={data.value?.socketHtml ?? ""}
            />

            {/* §6 — Feature grid (spotlight follow-mouse) */}
            <FeatureGrid features={features} />

            {/* §7 — Closing CTA (install + docs) */}
            <CallToAction />

            {/* Footer */}
            <footer class={css.footer}>
                <div class={css.footerInner}>
                    <span class={css.logo}>VeloJS</span>
                    <div class={css.footerLinks}>
                        <Link to="/docs/getting-started" class={css.footerLink}>Docs</Link>
                        <a href="https://github.com/mauro-andre/velojs" target="_blank" class={css.footerLink}>GitHub</a>
                        <a href="https://www.npmjs.com/package/@mauroandre/velojs" target="_blank" class={css.footerLink}>npm</a>
                    </div>
                    <p class={css.footerCopyright}>&copy; {new Date().getFullYear()} Mauro André Silva. MIT License.</p>
                </div>
            </footer>
        </div>
    );
};
