import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, Send } from "lucide-react";
import LangToggle from "../components/LangToggle";

/* Telegram in three steps: paste the bot token from @BotFather, have each phone open the bot and choose /police,
   /hospital or /family, send a test. From then on every incident the camera agents detect is pushed to those chats. */
const ROLE_LABEL: Record<string, string> = { police: "Police control room", hospital: "Hospital emergency desk", family: "Victim's family" };

export default function TelegramSetup() {
  const [st, setSt] = useState<any>(null);
  const [links, setLinks] = useState<any>(null);
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<any>(null);
  const [replacing, setReplacing] = useState(false);
  const [operatorOnly, setOperatorOnly] = useState(false);
  const load = () => {
    fetch("/api/telegram/status").then((r) => r.json()).then(setSt).catch(() => setSt(null));
    fetch("/api/telegram/links").then((r) => { setOperatorOnly(r.status === 404); return r.ok ? r.json() : null; }).then(setLinks).catch(() => setLinks(null));
  };
  useEffect(() => { load(); const h = setInterval(load, 3000); return () => clearInterval(h); }, []);
  const save = async () => {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/telegram/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setToken(""); setReplacing(false); setMsg(`Connected to @${j.bot}.`); load(); } else setMsg(typeof j.detail === "string" ? j.detail : "That doesn't look like a bot token (it looks like 123456789:ABC…).");
  };
  const sendTest = async () => { setTest("sending"); setTest(await (await fetch("/api/telegram/test-all", { method: "POST" })).json()); };
  const ready = !!st?.ok;
  const bot = links?.bot || st?.bot;
  const roles = links?.roles ?? {};
  const anyRole = Object.values(roles).some((v: any) => v.length);
  const Step = ({ done, n, title, children }: any) => (
    <section className="border border-ink bg-panel p-5">
      <div className="mb-3 flex items-center gap-2 text-lg font-bold">{done ? <CheckCircle2 className="text-ok" size={20} /> : <Circle size={20} className="text-muted" />}{n}. {title}</div>
      {children}
    </section>
  );
  if (operatorOnly) return (   // the public demo keeps the bot's setup and its chats to the operator
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-bold">Telegram alerts</h1>
      <p className="text-sm text-muted">Every incident the camera agents detect goes out on Telegram within seconds: the police control room gets the location, severity and any vehicle that fled; the hospital gets the incoming patient and the treat-first note; the family is told which hospital.</p>
      <p className="border border-line bg-panel p-4 text-sm">{st?.ok ? <>Connected to <b>@{st.bot}</b>. </> : null}Setting up the bot and sending alerts is limited to the operator on this public demo.</p>
    </div>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Telegram alerts</h1><span className="flex items-center gap-3"><LangToggle /><Link to="/" className="text-sm text-accent">← City map</Link></span></div>
      <p className="text-sm text-muted">Every incident the camera agents detect goes out on Telegram within seconds: the police control room gets the location, severity and any vehicle that fled; the hospital gets the incoming patient and the treat-first note; the family is told which hospital.</p>

      <Step done={ready} n={1} title="Connect your bot">
        {ready && !replacing ? <p className="text-sm">Connected to <b>@{st.bot}</b>. <button onClick={() => setReplacing(true)} className="text-xs text-accent underline">Replace the token</button></p> : <>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
            <li>In Telegram, open <b>@BotFather</b> and send <code>/newbot</code>.</li>
            <li>Pick a name and a username ending in <code>bot</code>.</li>
            <li>Paste the token it gives you here. It's stored only in <code>backend/.env</code> on this machine.</li>
          </ol>
          <div className="flex gap-2">
            <input aria-label="Bot token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:ABCdef…" className="flex-1 border border-ink bg-bg px-3 py-2 font-mono text-sm" type="password" />
            <button disabled={busy || token.trim().length < 20} onClick={save} className="bg-accent px-4 py-2 font-semibold text-white disabled:opacity-40">{busy ? "Checking…" : "Connect"}</button>
          </div>
          {st && !st.ok && st.token && <p className="mt-2 text-sm text-bad">{st.detail}</p>}
        </>}
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </Step>

      <Step done={anyRole} n={2} title="Choose who receives what">
        <p className="mb-2 text-sm">On each phone, open {bot ? <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer" className="font-semibold text-accent">t.me/{bot}</a> : "your bot"}, press <b>Start</b>, then tap one:</p>
        <div className="mb-3 flex flex-wrap gap-2 text-sm font-mono">{["/police", "/hospital", "/family", "/all"].map((c) => <span key={c} className="border border-ink px-2 py-0.5">{c}</span>)}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {Object.keys(ROLE_LABEL).map((r) => (
            <div key={r} className="border border-line p-3 text-sm">
              <div className="font-semibold">{ROLE_LABEL[r]}</div>
              {(roles[r] ?? []).length ? (roles[r] as any[]).map((c) => <div key={c.chat} className="text-ok">● {c.name || "chat"} <span className="text-muted">({c.chat})</span></div>) : <div className="text-muted">no chat yet</div>}
            </div>
          ))}
        </div>
        {links?.conflict ? (
          <div className="mt-3 border-2 border-warn bg-warn/10 p-3 text-sm">
            <div className="font-bold">Another computer is running this bot too</div>
            <p className="mt-1">Alerts still go out from here, but when someone taps a button in the bot, Telegram gives the tap to only one of the two computers. It can land on the other one and never register here.</p>
            <p className="mt-1">To fix it, do one of these:</p>
            <ul className="mt-1 list-disc pl-5">
              <li>Stop the other copy: ask whoever else has this token to close their YATHARTH server, or set <code>TELEGRAM_LINKER=off</code> in their <code>backend/.env</code>. Theirs can still send alerts that way.</li>
              <li>Or lock it out: in @BotFather send <code>/revoke</code>, pick this bot, then use "Replace the token" above with the new one. The old token stops working everywhere, including for your teammates.</li>
            </ul>
            <p className="mt-1">Then tap your buttons in the bot again.</p>
          </div>
        ) : links?.error && <p className="mt-2 text-xs text-bad">Bot: {links.error}</p>}
        <div className="mt-4 border-t border-line pt-3">
          <div className="text-sm font-semibold">Case phones (vehicle of interest / victim)</div>
          <p className="mb-2 text-xs text-muted">Phones registered on a case (contacts.json) get their own alert by SMS and Telegram the moment the case is dispatched. Each one links itself: open the bot, press Start, tap <b>📱 Share my phone number</b>.</p>
          <ul className="space-y-1 text-sm">
            {(links?.contacts ?? []).map((c: any) => (
              <li key={c.number} className="flex flex-wrap items-center justify-between gap-2 border border-line px-3 py-1.5">
                <span className="font-mono">{c.number.replace(/(\+?\d{2})(\d{2})\d{4}(\d{4})/, "$1 $2•••• $3")}</span>
                <span className="text-xs text-muted">{c.roles.join(", ")}</span>
                <span className={c.linked ? "text-ok" : "text-muted"}>{c.linked ? "● linked" : "not linked yet"}</span>
              </li>
            ))}
            {!(links?.contacts ?? []).length && <li className="text-xs text-muted">No case has phone contacts yet.</li>}
          </ul>
        </div>
      </Step>

      <Step done={test && test !== "sending" && Object.values(test).some((x: any) => x.status === "sent")} n={3} title="Send a test">
        <button disabled={!ready || test === "sending"} onClick={sendTest} className="flex items-center gap-2 bg-ink px-4 py-2 font-semibold text-white disabled:opacity-40"><Send size={14} />Send a test to every chat</button>
        {test && test !== "sending" && <ul className="mt-2 space-y-0.5 text-sm">{Object.entries(test).map(([r, x]: any) => <li key={r}><b>{ROLE_LABEL[r]}</b>: {x.status}{x.latency_ms != null ? ` in ${x.latency_ms} ms` : ""}{x.detail ? ` · ${x.detail}` : ""}</li>)}</ul>}
      </Step>
    </div>
  );
}
