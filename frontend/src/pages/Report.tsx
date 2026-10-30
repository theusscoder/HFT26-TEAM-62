import { useParams } from "react-router-dom";
import { useApi, type Event } from "../lib/api";
import { KindBadge, Loading, Panel, Ref } from "../components/ui";

/* OWNER: P3 (+P2 for GET /report.pdf). Evidence-linked report + custody chain verification.
   Wording rule: "consistent with" / "not supported by"; never fault or blame. */
export default function Report() {
  const { id } = useParams();
  const ev = useApi<Event[]>(`/cases/${id}/events`);
  const cu = useApi<any>(`/cases/${id}/custody`);
  if (!ev.data || !cu.data) return <Loading error={ev.error ?? cu.error} />;
  return (
    <div className="space-y-6">
      <Panel title="Custody chain" right={<span className={`text-xs ${cu.data.verify.ok ? "text-ok" : "text-bad"}`}>{cu.data.verify.ok ? "verified" : `broken at ${cu.data.verify.broken_at}`}</span>}>
        <ul className="mono space-y-1 text-[11px] text-muted">
          {cu.data.entries.map((e: any) => <li key={e.seq}>#{e.seq} {e.time} {e.action} {JSON.stringify(e.details)}</li>)}
          {!cu.data.entries.length && <li>No entries yet. Upload evidence on the New case page.</li>}
        </ul>
      </Panel>
      <Panel title="Findings with evidence">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {ev.data.map((e) => (
              <tr key={e.id}>
                <td className="mono py-2 pr-3 text-xs text-muted">{e.id}</td>
                <td className="pr-3"><KindBadge kind={e.kind} /></td>
                <td className="pr-3">{e.actor} · {e.action} {e.value ?? ""}</td>
                <td className="mono pr-3 text-xs">T{e.t.start >= 0 ? "+" : ""}{e.t.start}s</td>
                <td><Ref value={e.ref || (e.derived_from.length ? `from ${e.derived_from.join(", ")}` : "")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
