// Inspect native authentication before looking for the signed-in page's Rspack runtime.
export function createRuntimeDiscoveryExpression(): string {
  return String.raw`(async () => {
    const imports = globalThis.__reactRouterManifest?.entry?.imports;
    if (!Array.isArray(imports)) throw new Error("RUNTIME_DRIFT:entry_imports");
    const modules = [];
    for (const path of imports) {
      const url = new URL(path, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith("/cdn/assets/")) continue;
      modules.push({ url: url.href, module: await import(url.href) });
    }
    // A retained auth/session response can still contain a user while the page's native
    // bootstrap is logged out. The logged-out build has no __webpack_require__ export.
    const probes = [...new Set(modules.flatMap(({ module }) => Object.values(module)).filter(value =>
      typeof value === "function" && value.length === 0 &&
      /return [\w$]+\(\)\.authStatus\s*===\s*[\w$]+\.LoggedIn\s*;?\s*\}/.test(Function.prototype.toString.call(value))
    ))];
    if (probes.length > 1) throw new Error("RUNTIME_DRIFT:native_auth:" + probes.length);
    if (probes.length === 1 && probes[0]() === false) throw new Error("AUTH_REQUIRED:native_runtime_logged_out");
    const matches = modules.filter(({ module }) => {
      const runtime = module.__webpack_require__;
      return typeof runtime === "function" && runtime.m && runtime.c;
    });
    if (matches.length !== 1) throw new Error("RUNTIME_DRIFT:rspack_runtime:" + matches.length);
    return matches[0].url;
  })()`;
}
