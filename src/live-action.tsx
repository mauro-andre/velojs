/**
 * Live actions — client runtime.
 *
 * A tab is not a route: it is client state, and its content loads at open time
 * from an action with its own arguments (the resource id, the file path). When
 * that content is a **value that tracks server state over time**, the action
 * declares interest in living (`liveActions` in the route module) and the tab
 * subscribes:
 *
 * ```tsx
 * const { data, loading, freshness } = useLiveAction(action_abrirFicha, { id });
 * ```
 *
 * The hook receives the action itself — its client stub, which the Vite plugin
 * marks with the subscription address (`__path`, the socket-stub ruler) — and
 * the args. It opens ONE SSE connection per subscription at
 * `GET /_live/{moduleId}/{actionName}?_args=<json>`; the connect snapshot (the
 * action executed once with the declared args) is the whole loading gesture —
 * there is no initial POST. Every `emit()` in any of the action's declared
 * channels re-executes the action server-side with the same args and pushes the
 * fresh value, which **replaces** `data` whole (no merge — the updated payload
 * has the same shape as the original answer).
 *
 * The subscription's life is the mount: the tab component unmounts (tab closed,
 * page left) and the connection closes — nothing arrives afterwards and the
 * server holds nothing for the gone. It remounts (tab reopened, refresh
 * restored the tabs) and the subscription is born again with a snapshot of the
 * current state: reopening is indistinguishable from never having closed. The
 * args are the identity — changing them reconnects (new subscription, new
 * snapshot), the twin of the loader connection keyed by its route params.
 *
 * `freshness` is the subscription's own `"live"` / `"stale"` / `"error"` signal
 * — the same three states and the same 60s silence detector as the live loader
 * — and it never touches the page aggregate: a stale tab does not stale the
 * page, and the other way around.
 *
 * On the server (SSR) the hook does not connect: the tab is client state the
 * server does not know, so it returns `data` null with `loading` true. In a
 * static build the load really failed (there is no server to run the action):
 * no connection is opened and the handle is `data` undefined, `loading` false,
 * `freshness` `"error"` — the deliberate contrast with a channel, which stays
 * `"live"` because there is nothing to sync.
 */
import { useSignal, type Signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { CHANNEL_SILENCE_MS, type Freshness } from "./live-loader.js";

declare const __VELO_STATIC__: boolean;

/** SSE event name of a value that replaces the subscription's data. */
const SNAPSHOT_EVENT = "snapshot";

/**
 * The client stub of a live action — the form the Vite plugin generates for an
 * action the module declares in `liveActions`. The call signature is the
 * action's own (typed from its `ActionArgs` and return); the live marks are
 * what `useLiveAction` reads to find the subscription address.
 */
export interface LiveActionStub<TArgs extends Record<string, unknown>, TData> {
    (args: { body: TArgs }): Promise<TData>;
    /** Set by the Vite plugin on every stub the module declares live. */
    __isVeloLiveAction?: boolean;
    /** `/_live/{moduleId}/{actionName}` — the subscription address. */
    __path?: string;
}

/** What `useLiveAction` returns. */
export interface LiveActionHandle<T> {
    /** The action's return, replaced whole by every snapshot. */
    data: Signal<T | null | undefined>;
    /** True until the first snapshot or error of the current subscription. */
    loading: Signal<boolean>;
    /** The subscription's own freshness — never the page aggregate's. */
    freshness: Signal<Freshness>;
}

/**
 * Subscribes to a live action and reads its value as it tracks server state.
 *
 * The connection is keyed by the args: passing different args is a different
 * subscription (the old one closes, the new one opens with a fresh snapshot).
 * The life is the mount — unmount closes, remount reopens with the current
 * state. See the module docs for the full contract.
 *
 * ```tsx
 * export const Component = () => {
 *     const { data, loading, freshness } = useLiveAction(action_abrirFicha, { id: 7 });
 *     if (loading.value) return <div class="tab-loading" />;
 *     return <article class={freshness.value}>{data.value?.nome}</article>;
 * };
 * ```
 */
export function useLiveAction<TArgs extends Record<string, unknown>, TData>(
    action: LiveActionStub<TArgs, TData>,
    args: TArgs,
): LiveActionHandle<TData> {
    const data = useSignal<TData | null | undefined>(null);
    const loading = useSignal<boolean>(true);
    const freshness = useSignal<Freshness>("live");

    // The args are the subscription's identity: the serialized form keys the
    // effect, so a new address reconnects and the same address never does.
    const argsKey = JSON.stringify(args ?? {});

    useEffect(() => {
        // SSR: the tab is client state the server does not know — no
        // connection, null data, loading until the client takes over.
        if (typeof window === "undefined") return;

        // Static build: the load really failed — there is no server to run the
        // action. Deliberately NOT the channel's inert-"live": a tab that
        // cannot load its content is a failure, not inactivity.
        if (typeof __VELO_STATIC__ !== "undefined" && __VELO_STATIC__) {
            loading.value = false;
            freshness.value = "error";
            data.value = undefined;
            return;
        }

        if (!action.__isVeloLiveAction || !action.__path) {
            console.warn(
                "[velojs] useLiveAction: this action has no live declaration — " +
                "add it to the module's `liveActions` export " +
                "(e.g. `export const liveActions = { abrirFicha: [\"fichaProjeto\"] };`).",
            );
            loading.value = false;
            freshness.value = "error";
            return;
        }

        // A new subscription is a fresh attempt: loading restarts (the
        // previous value stays on screen until the new snapshot arrives —
        // stale-while-revalidate, the house ruler).
        loading.value = true;

        const url = `${action.__path}?_args=${encodeURIComponent(argsKey)}`;
        const es = new EventSource(url);

        // The silence clock: armed on connect (the connect snapshot is the
        // first delivery) and restarted by every delivery that follows. The
        // server's heartbeat comment generates no client event, so it can
        // neither restart it nor mask the silence.
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        const armSilence = (): void => {
            if (silenceTimer !== null) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                silenceTimer = null;
                freshness.value = "stale";
            }, CHANNEL_SILENCE_MS);
        };
        armSilence();

        es.addEventListener(SNAPSHOT_EVENT, (e) => {
            try {
                data.value = JSON.parse((e as MessageEvent).data) as TData;
                loading.value = false;
                freshness.value = "live";
                armSilence();
            } catch {
                // Malformed payload: keep the previous value (a failed push
                // must never blank the tab).
            }
        });

        es.addEventListener("error", (e) => {
            const payload = (e as MessageEvent).data;
            if (typeof payload === "string" && payload.length > 0) {
                // Server-reported action failure (the `error` SSE event): the
                // subscription keeps its last valid value and says so.
                loading.value = false;
                freshness.value = "error";
                return;
            }
            // A native connection error carries no data: reconnecting or
            // closed — stale, not errored. A reconnect's snapshot brings the
            // freshness back to "live" on its own.
            freshness.value = "stale";
        });

        es.addEventListener("close", () => {
            freshness.value = "stale";
        });

        return () => {
            if (silenceTimer !== null) clearTimeout(silenceTimer);
            try {
                es.close();
            } catch {
                // already closed
            }
        };
    }, [action.__path, argsKey]);

    return { data, loading, freshness };
}
