import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";
import { Button, Card, Field, Notice, inputClass } from "../components/ui";

const DEMO_ACCOUNTS = [
  { username: "caseworker", role: "NGO caseworker", does: "Intake and screening" },
  { username: "lawyer", role: "Legal-aid lawyer", does: "Draft and file s.479 applications" },
  { username: "issuer", role: "Demo court issuer", does: "Attest and revoke orders" },
  { username: "prison", role: "Demo prison superintendent", does: "s.479(3) application, receipt, release" },
];

export function Login() {
  const { user, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (location.state as { from?: string } | null)?.from ?? "/dashboard";

  if (user) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
      <Card title="Sign in">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Username">
            <input className={inputClass} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
      <Card title="Demo accounts">
        <p className="text-[0.95rem] text-stone-700">
          All demo accounts share the password set in <code className="font-mono">DEMO_PASSWORD</code> (default{" "}
          <code className="font-mono">bailbridge-demo</code>). Each role account is mapped to one wallet address; the server checks that
          on-chain actions are signed by that wallet.
        </p>
        <ul className="mt-4 space-y-2">
          {DEMO_ACCOUNTS.map((a) => (
            <li key={a.username}>
              <button
                type="button"
                onClick={() => setUsername(a.username)}
                className="w-full rounded-lg border border-paper-200 px-3 py-2 text-left hover:border-navy-200 hover:bg-navy-50"
              >
                <span className="font-mono font-semibold">{a.username}</span>
                <span className="ml-2 text-sm text-stone-600">
                  {a.role} — {a.does}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
