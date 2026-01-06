import { hydrate } from "preact";
import { Routes } from "./client-routes.js";

// Hydrate the SSR content
const root = document.getElementById("app");

if (root) {
  hydrate(<Routes />, root);
}
