import { signal, effect } from "@preact/signals";
import { Landing } from "./Landing.js";
import { Docs } from "./Docs.js";

export const hash = signal(window.location.hash || "#/");

window.addEventListener("hashchange", () => {
    hash.value = window.location.hash || "#/";
});

// Scroll to top on navigation
effect(() => {
    hash.value; // subscribe
    window.scrollTo(0, 0);
});

export function App() {
    if (hash.value.startsWith("#/docs")) {
        return <Docs />;
    }

    return <Landing />;
}
