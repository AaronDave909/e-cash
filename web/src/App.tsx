import { useEffect, useState } from "react";
import { SessionProvider } from "./session";
import { SystemView } from "./views/SystemView";
import { UsersView } from "./views/UsersView";

type Theme = "light" | "dark" | "auto";
const THEME_KEY = "ecash.theme";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

export function App() {
  const [view, setView] = useState<"users" | "system">("users");
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "auto") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const next: Record<Theme, Theme> = { auto: "dark", dark: "light", light: "auto" };
  return (
    <SessionProvider>
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            ₱
          </span>
          E-Cash
        </div>
        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={view === "users"} className={view === "users" ? "on" : ""} onClick={() => setView("users")}>
            Users
          </button>
          <button role="tab" aria-selected={view === "system"} className={view === "system" ? "on" : ""} onClick={() => setView("system")}>
            System &amp; Ledger Health
          </button>
        </nav>
        <button className="btn btn-ghost btn-sm" onClick={() => setTheme(next[theme])} aria-label="Change theme">
          Theme: {theme}
        </button>
      </header>
      <main>{view === "users" ? <UsersView /> : <SystemView />}</main>
    </SessionProvider>
  );
}
