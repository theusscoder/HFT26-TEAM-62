import { useEffect, useState } from "react";
import { getLang, onLang, setLang, type Lang } from "../lib/i18n";

/* English / Telugu switch. Marked no-translate so its own labels never change. */
export default function LangToggle({ dark }: { dark?: boolean }) {
  const [lang, set] = useState<Lang>(getLang());
  useEffect(() => onLang(() => set(getLang())), []);
  const btn = (l: Lang, label: string) => (
    <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}
      className={`px-2 py-1 text-[12px] font-semibold ${lang === l ? (dark ? "bg-white text-black" : "bg-ink text-white") : dark ? "text-white/70 hover:bg-white/10" : "text-muted hover:bg-panel-2"}`}>{label}</button>
  );
  return <div data-notranslate role="group" aria-label="Language" className={`inline-flex border ${dark ? "border-white/25 bg-black/40" : "border-ink"}`}>{btn("en", "EN")}{btn("te", "తెలుగు")}</div>;
}
