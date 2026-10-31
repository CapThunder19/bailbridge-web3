import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useSession } from "../lib/session";
import { deployment, networkLabel } from "../lib/deployment";
import { ROLE_LABEL } from "../lib/format";
import { connectWallet, explainWalletError, hasWallet, short } from "../lib/wallet";

function WalletButton({ expected }: { expected: string | null }) {
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    void (eth.request({ method: "eth_accounts" }) as Promise<string[]>).then((a) => setAccount(a[0] ?? null)).catch(() => undefined);
    const onChange = (...args: unknown[]) => setAccount(((args[0] as string[]) ?? [])[0] ?? null);
    eth.on?.("accountsChanged", onChange);
    return () => eth.removeListener?.("accountsChanged", onChange);
  }, []);

  if (!deployment || !expected) return null;
  if (!hasWallet()) return <span className="text-xs text-paper-200">No wallet detected</span>;
  const mismatch = account && account.toLowerCase() !== expected.toLowerCase();
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => connectWallet().then(setAccount, (e) => setError(explainWalletError(e)))}
        className={`rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-inset ${
          mismatch ? "bg-red-50 text-red-900 ring-red-300" : account ? "bg-navy-700 text-paper ring-navy-400" : "bg-gold-500 text-navy-900 ring-gold-300"
        }`}
        title={mismatch ? `Expected ${expected}` : account ?? "Connect wallet"}
      >
        {account ? (mismatch ? `Wrong account ${short(account, 4)}` : `Wallet ${short(account, 4)}`) : "Connect wallet"}
      </button>
      {error && <span className="mt-1 max-w-xs text-right text-xs text-red-200">{error}</span>}
    </div>
  );
}

export function Layout() {
  const { user, config, logout } = useSession();
  const navigate = useNavigate();
  const offChain = !deployment || (config !== null && !config.chain.enabled);
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-2 text-[0.95rem] font-medium ${isActive ? "bg-navy-700 text-white" : "text-paper-100 hover:bg-navy-700/60"}`;

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="bg-navy-900 text-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-8 w-8" />
            <span className="font-serif text-xl font-semibold tracking-tight">BailBridge</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1" aria-label="Main">
            {user && <NavLink to="/dashboard" className={navClass}>Dashboard</NavLink>}
            {user && (user.role === "caseworker" || user.role === "lawyer") && (
              <NavLink to="/cases/new" className={navClass}>New case</NavLink>
            )}
            <NavLink to="/verify" className={navClass}>Verify</NavLink>
            <NavLink to="/release-clock" className={navClass}>Release clock</NavLink>
          </nav>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <WalletButton expected={user.walletAddress} />
                <div className="text-right leading-tight">
                  <div className="text-sm font-semibold">{user.displayName}</div>
                  <div className="text-xs text-gold-300">{ROLE_LABEL[user.role]}</div>
                </div>
                <button
                  type="button"
                  onClick={() => logout().then(() => navigate("/login"))}
                  className="rounded-md px-2 py-1 text-sm text-paper-200 hover:bg-navy-700"
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="rounded-lg bg-gold-500 px-3 py-1.5 text-sm font-semibold text-navy-900 hover:bg-gold-300">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      {offChain ? (
        <div className="bg-gold-100 text-gold-700">
          <p className="mx-auto max-w-6xl px-4 py-2 text-sm font-semibold">
            Off-chain demo — no blockchain attestations. Intake, screening, timeline and PDFs work; wallet actions are disabled.
          </p>
        </div>
      ) : (
        <div className="bg-navy-800 text-paper-200">
          <p className="mx-auto max-w-6xl px-4 py-1 text-xs">
            Registry on {networkLabel()} · <span className="font-mono">{short(deployment!.address)}</span> · synthetic demo data
          </p>
        </div>
      )}

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-paper-200 bg-paper-100">
        <div className="mx-auto max-w-6xl px-4 py-5 text-sm text-stone-600">
          BailBridge is a prototype coordination and audit tool on synthetic data. It is not a court system, does not decide bail, and is not
          legal advice. Institutional identities shown are Demo identities.
        </div>
      </footer>
    </div>
  );
}
