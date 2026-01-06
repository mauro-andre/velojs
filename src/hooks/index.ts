/**
 * VeloJS Hooks
 *
 * Hooks Preact para usar no client-side
 *
 * @example
 * ```tsx
 * import { useLoaderData, useAction, revalidate } from "velojs/hooks";
 *
 * export default function Page() {
 *   const { value, loading } = useLoaderData<typeof loader>();
 *   const [create, creating] = useAction(action_createUser);
 *
 *   const handleCreate = async () => {
 *     await create("John", "john@example.com");
 *     revalidate();
 *   };
 *
 *   return <div>...</div>;
 * }
 * ```
 */

export {
  useLoaderData,
  revalidate,
  clearLoaderCache,
} from "./useLoaderData.js";

export { useAction } from "./useAction.js";
