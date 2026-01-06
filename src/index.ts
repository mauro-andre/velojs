/**
 * VeloJS - Full-stack framework with Server Actions, SSR and Signals
 *
 * @example
 * ```ts
 * import { route, layout } from "velojs";
 *
 * export default [
 *   layout("./admin/layout.tsx", {
 *     prefix: "/admin",
 *     routes: [
 *       route("/users", "./admin/users/page.tsx"),
 *     ],
 *   }),
 * ];
 * ```
 */

// Core helpers
export { route } from "./core/route.js";
export { layout } from "./core/layout.js";

// Types
export type {
  RouteDefinition,
  LayoutDefinition,
  RouteConfig,
  LoaderArgs,
  LoaderFunction,
  ServerAction,
  ServerActionContext,
  VeloConfig,
} from "./types.js";

export { isLayout } from "./types.js";
