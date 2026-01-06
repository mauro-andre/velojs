import { Route, Switch } from "wouter-preact";
import { lazy } from "preact/compat";

const Page0 = lazy(() => import("./home/page.client.js"));
const Page1 = lazy(() => import("./admin/users/page.client.js"));

export function Routes() {
  return (
    <Switch>
      <Route path="/" component={Page0} />
      <Route path="/admin/users" component={Page1} />
      <Route path="*" component={() => <div>404 Not Found</div>} />
    </Switch>
  );
}
