/**
 * VeloJS Hooks
 *
 * Hooks Preact para usar no client-side
 *
 * @example
 * ```tsx
 * import { useLoaderData, useAction } from "velojs/hooks";
 *
 * export default function Page() {
 *   const { value, loading } = useLoaderData<typeof loader>();
 *   const [create, creating] = useAction(action_createUser);
 *
 *   return <div>...</div>;
 * }
 * ```
 */

// TODO: Implementar hooks
export function useLoaderData() {
  throw new Error("useLoaderData not implemented yet");
}

export function useAction() {
  throw new Error("useAction not implemented yet");
}

export function revalidate() {
  throw new Error("revalidate not implemented yet");
}
