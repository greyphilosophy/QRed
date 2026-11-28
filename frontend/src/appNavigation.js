import { useCallback, useEffect, useState } from "react";

const paths = { home: "/", check: "/check", camera: "/check/camera", seal: "/seal", about: "/about" };
const routes = Object.fromEntries(Object.entries(paths).map(([name, path]) => [path, name]));
export const routeFromHash = hash => routes[hash.replace(/^#/, "")] || "home";
const currentRoute = () => routeFromHash(window.location.hash);

// Hash routes share the cached homepage, including when the device is offline.
// Only navigation metadata goes into history; documents and keys stay in React.
export function useAppNavigation() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    if (!window.history.state?.qredNavigation) {
      window.history.replaceState({ ...window.history.state, qredNavigation: { depth: 0 } }, "");
    }
    const sync = () => setRoute(currentRoute());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const navigate = useCallback((next, { replace = false } = {}) => {
    if (!Object.hasOwn(paths, next) || next === currentRoute()) return;
    const previous = window.history.state?.qredNavigation || { depth: 0 };
    const entry = replace ? previous : { depth: previous.depth + 1, from: currentRoute() };
    window.history[replace ? "replaceState" : "pushState"](
      { ...window.history.state, qredNavigation: entry }, "", "#" + paths[next]);
    setRoute(next);
  }, []);
  const back = useCallback(() => {
    if (window.history.state?.qredNavigation?.depth > 0) window.history.back();
    else navigate("home", { replace: true });
  }, [navigate]);
  const review = useCallback(() => {
    if (window.history.state?.qredNavigation?.from === "check") window.history.back();
    else navigate("check", { replace: true });
  }, [navigate]);
  return { route, navigate, back, review };
}

export function isMobileDevice(device = navigator) {
  if (typeof device.userAgentData?.mobile === "boolean") return device.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent || "") ||
    (device.platform === "MacIntel" && device.maxTouchPoints > 1);
}
