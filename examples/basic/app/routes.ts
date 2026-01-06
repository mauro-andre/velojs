import { layout, route } from "velojs";

export default [
  layout("./layout.tsx", {
    routes: [
      route("/", "./home/page.tsx"),
      
      layout("./admin/layout.tsx", {
        prefix: "/admin",
        routes: [
          route("/users", "./admin/users/page.tsx"),
        ],
      }),
    ],
  }),
];
