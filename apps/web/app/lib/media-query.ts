// Older embedded WebKit exposes MediaQueryList's original listener API.
export function onMediaChange(query: MediaQueryList, change: () => void) {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }
  query.addListener(change);
  return () => query.removeListener(change);
}
