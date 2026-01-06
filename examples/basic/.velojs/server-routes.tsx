import { Hono } from "hono";
import { renderPage } from "velojs/runtime";

const app = new Hono();

import * as route0 from "./home/page.server.js";
import Component0 from "./home/page.client.js";
import * as layout0_0Server from "./layout.server.js";
import layout0_0Component from "./layout.client.js";
import * as route1 from "./admin/users/page.server.js";
import Component1 from "./admin/users/page.client.js";
import * as layout1_0Server from "./layout.server.js";
import layout1_0Component from "./layout.client.js";
import * as layout1_1Server from "./admin/layout.server.js";
import layout1_1Component from "./admin/layout.client.js";


// Route: /
app.get("/", async (c) => {
  // 1. Executa loaders (layouts + page)
  const data: any = {};
  
  if (layout0_0Server.loader) {
    data.layout0 = await layout0_0Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  if (route0.loader) {
    data.page = await route0.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  // 2. Renderiza componentes nested (de dentro pra fora)
  let rendered = <Component0 />;
  rendered = <layout0_0Component>{rendered}</layout0_0Component>;

  // 3. Renderiza com SSR usando renderPage
  return renderPage(c, rendered, data);
});

// Data API (navegação SPA)
app.get("/", async (c) => {
  if (c.req.query("_data") !== "1") {
    return c.next();
  }

  const data: any = {};
  
  if (layout0_0Server.loader) {
    data.layout0 = await layout0_0Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  if (route0.loader) {
    data.page = await route0.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  return c.json(data);
});


// Route: /admin/users
app.get("/admin/users", async (c) => {
  // 1. Executa loaders (layouts + page)
  const data: any = {};
  
  if (layout1_0Server.loader) {
    data.layout0 = await layout1_0Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }
  if (layout1_1Server.loader) {
    data.layout1 = await layout1_1Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  if (route1.loader) {
    data.page = await route1.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  // 2. Renderiza componentes nested (de dentro pra fora)
  let rendered = <Component1 />;
  rendered = <layout1_1Component>{rendered}</layout1_1Component>;
  rendered = <layout1_0Component>{rendered}</layout1_0Component>;

  // 3. Renderiza com SSR usando renderPage
  return renderPage(c, rendered, data);
});

// Data API (navegação SPA)
app.get("/admin/users", async (c) => {
  if (c.req.query("_data") !== "1") {
    return c.next();
  }

  const data: any = {};
  
  if (layout1_0Server.loader) {
    data.layout0 = await layout1_0Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }
  if (layout1_1Server.loader) {
    data.layout1 = await layout1_1Server.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  if (route1.loader) {
    data.page = await route1.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
  }

  return c.json(data);
});


// Action: /admin/users/action_createUser
app.post("/api/admin/users/action_createUser", async (c) => {
  try {
    // Parse body
    const body = await c.req.json();
    const args = body.args || [];

    // Executa action
    if (!route1.action_createUser) {
      return c.json({ error: "Action not found" }, 404);
    }

    const result = await route1.action_createUser(...args);
    return c.json({ success: true, data: result });
  } catch (error) {
    console.error("Action error:", error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});


// Action: /admin/users/action_deleteUser
app.post("/api/admin/users/action_deleteUser", async (c) => {
  try {
    // Parse body
    const body = await c.req.json();
    const args = body.args || [];

    // Executa action
    if (!route1.action_deleteUser) {
      return c.json({ error: "Action not found" }, 404);
    }

    const result = await route1.action_deleteUser(...args);
    return c.json({ success: true, data: result });
  } catch (error) {
    console.error("Action error:", error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    }, 500);
  }
});


export default app;
