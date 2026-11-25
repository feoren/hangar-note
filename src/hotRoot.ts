// The React root survives hot reloads in development: when Vite runs main.tsx again, creating a
// second root on the same element would make React warn and render two trees. The root is kept in
// `import.meta.hot.data`, which Vite hands to the next run of the module. In a build there is no
// `import.meta.hot`, and the root is simply created.

import type { Root } from "react-dom/client";

const KEY = "root";

function isRoot(value: unknown): value is Root {
  return (
    typeof value === "object" &&
    value !== null &&
    "render" in value &&
    typeof value.render === "function" &&
    "unmount" in value &&
    typeof value.unmount === "function"
  );
}

/** The root kept in `data` from the last run, or a new one created by `create` and kept there. */
export function reuseRoot(data: unknown, create: () => Root): Root {
  if (typeof data !== "object" || data === null) return create();
  const kept: unknown = Reflect.get(data, KEY);
  if (isRoot(kept)) return kept;
  const root = create();
  Reflect.set(data, KEY, root);
  return root;
}
