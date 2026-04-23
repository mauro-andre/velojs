import { useEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";

/**
 * Returns a ref + boolean flag that flips to `true` the first time the
 * referenced element enters the viewport. One-shot — disconnects after the
 * first intersection so animations don't re-trigger on scroll.
 *
 * Falls back to `true` during SSR (no IntersectionObserver), which means the
 * baked HTML ships in the "visible" state and the client takes over on mount.
 */
export function useInView<T extends Element = HTMLElement>(
    threshold: number = 0.2
): [RefObject<T>, boolean] {
    // SSR: no window — consider visible so the HTML is not blank.
    const ssr = typeof window === "undefined";
    const [visible, setVisible] = useState(ssr);
    const ref = useRef<T>(null);

    useEffect(() => {
        if (ssr) return;
        const el = ref.current;
        if (!el) return;
        // After hydration, reset to hidden so we re-play the entry animation.
        setVisible(false);
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (entry && entry.isIntersecting) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { threshold, rootMargin: "0px 0px -10% 0px" }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [threshold]);

    return [ref, visible];
}
