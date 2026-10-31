import { useState } from "react";
import LangToggle from "./LangToggle";

/* Four looks for the same system, switchable live. Swiss: white, black, one red, on a grid. Command: dark, map-first, like a
   control room. Cockpit: dense dark slate with amber, like a dispatcher console. Paper: warm editorial, for reports. */
export const THEMES = [["swiss", "Swiss"], ["command", "Command"], ["cockpit", "Cockpit"], ["paper", "Paper"]] as const;
export type Theme = (typeof THEMES)[number][0];

export function initTheme() {
  let t: string | null = null;
  try { t = localStorage.getItem("yatharth-theme"); } catch { /* storage blocked: default theme */ }
  document.documentElement.dataset.theme = THEMES.some(([k]) => k === t) ? t! : "swiss";
}

export default function ThemePicker({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useState<string>(document.documentElement.dataset.theme ?? "swiss");
  function pick(t: Theme) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("yatharth-theme", t); } catch { /* not remembered, still applied */ }
    setTheme(t);
  }
  return (
    <div className={`flex ${compact ? "flex-wrap" : ""} gap-1`} role="radiogroup" aria-label="Theme">
      {THEMES.map(([k, l]) => (
        <button key={k} role="radio" aria-checked={theme === k} onClick={() => pick(k)}
          className={`border px-2 py-1 text-[11px] font-semibold ${theme === k ? "border-accent bg-accent text-white" : "border-line text-muted hover:text-ink"}`}>{l}</button>
      ))}
      <LangToggle />
    </div>
  );
}
