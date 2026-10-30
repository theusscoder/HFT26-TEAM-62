import { Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Loading } from "../components/ui";

// OWNER: P3. Landing + case list.
export default function Home() {
  const { data, error } = useApi<{ id: string; title: string; location: { name: string }; created: string }[]>("/cases");
  return (
    <div className="mx-auto max-w-4xl p-10">
      <h1 className="text-4xl font-bold tracking-tight">YATHARTH</h1>
      <p className="mt-2 max-w-xl text-muted">Every accident leaves fragments. We put them back together: what happened, who is telling the truth, and who must be told right now.</p>
      <div className="mt-8 flex gap-3">
        <Link to="/new" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">New case</Link>
      </div>
      <h2 className="mt-12 text-xs font-semibold uppercase tracking-wider text-muted">Cases</h2>
      {!data ? <Loading error={error} /> : (
        <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-panel">
          {data.map((c) => (
            <li key={c.id}>
              <Link to={`/case/${c.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-panel-2">
                <span className="font-medium">{c.title}</span>
                <span className="text-sm text-muted">{c.location.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
