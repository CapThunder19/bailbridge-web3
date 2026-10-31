import { Link } from "react-router-dom";
import { useSession } from "../lib/session";

const STEPS = [
  {
    title: "Review",
    body: "Screen each undertrial case against s.479 BNSS: one-half of the maximum term, one-third if never convicted, excluding accused-caused delay. Cases outside the rule or with other pending cases are routed for specialist review.",
  },
  {
    title: "File",
    body: "The jail superintendent records the s.479(3) written application. The lawyer reviews a DRAFT bail application and registers the exact PDF’s hash with a wallet signature.",
  },
  {
    title: "Verify",
    body: "A Demo court issuer attests the order. Anyone can drop the PDF on /verify: it is hashed locally and checked against the registry — altered files fail, revoked orders show REVOKED.",
  },
  {
    title: "Acknowledge",
    body: "The prison acknowledges receipt of the active order, then release. Every step is a timestamped attestation by a specific role.",
  },
];

export function Landing() {
  const { user } = useSession();
  return (
    <div className="space-y-14">
      <section className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-gold-700">Legal-aid coordination prototype</p>
          <h1 className="mt-3 font-serif text-4xl font-semibold leading-tight text-navy-900 sm:text-5xl">
            From detention threshold to verified release.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-navy-800">
            BailBridge helps legal-aid lawyers and NGO caseworkers see which undertrial cases need Section 479 BNSS review, who must act next —
            including the jail superintendent’s statutory duty — and whether bail documents are genuine.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to={user ? "/dashboard" : "/login"} className="rounded-lg bg-navy-800 px-5 py-3 text-lg font-semibold text-white hover:bg-navy-700">
              {user ? "Open the dashboard" : "Try the demo"}
            </Link>
            <Link to="/verify" className="rounded-lg bg-white px-5 py-3 text-lg font-semibold text-navy-800 ring-1 ring-inset ring-navy-200 hover:bg-navy-50">
              Verify a document
            </Link>
          </div>
        </div>
        <div className="rounded-2xl border border-gold-300 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-stone-600">Example (synthetic)</p>
          <p className="mt-2 font-serif text-xl font-semibold text-gold-700">
            Threshold reached 40 days ago — s.479(3) application and legal review required
          </p>
          <div className="mt-4 h-3 overflow-hidden rounded-full bg-paper-200" aria-hidden>
            <div className="h-full w-full rounded-full bg-gold-500" />
          </div>
          <p className="mt-2 text-[0.95rem] text-navy-800">588 / 548 qualifying days · one-half of a 3-year maximum</p>
          <p className="mt-4 rounded-lg bg-gold-100 px-3 py-2 text-[0.95rem] font-semibold text-gold-700">
            Superintendent application not recorded (40 days)
          </p>
        </div>
      </section>

      <section>
        <h2 className="font-serif text-3xl font-semibold">The problem</h2>
        <p className="mt-3 max-w-3xl text-lg leading-relaxed text-navy-800">
          Section 479 BNSS (formerly s.436A CrPC) provides for release of undertrials who have been detained for a set fraction of the maximum
          sentence, and requires the jail superintendent to apply to the court when that point is reached. In practice the people involved —
          lawyers, NGOs, prisons and courts — work from separate records, so it is hard to tell whether a threshold has passed, who has done
          their part, and whether an order in hand is the real one.
        </p>
      </section>

      <section>
        <h2 className="font-serif text-3xl font-semibold">Review → File → Verify → Acknowledge</h2>
        <ol className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-paper-200 bg-white p-5 shadow-sm">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-navy-800 font-bold text-white">{i + 1}</span>
              <h3 className="mt-3 font-serif text-xl font-semibold">{s.title}</h3>
              <p className="mt-2 text-[0.95rem] leading-relaxed text-navy-800">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border border-navy-100 bg-navy-50 p-6">
          <h2 className="font-serif text-2xl font-semibold">What the chain proves</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.95rem] leading-relaxed">
            <li>Which wallet, holding which role, attested each step — and when.</li>
            <li>That a document’s exact bytes are the ones registered; a one-byte change fails.</li>
            <li>That an order is ACTIVE or has been REVOKED, with history kept.</li>
            <li>That off-chain records still match the salted commitments anchored earlier.</li>
          </ul>
        </div>
        <div className="rounded-xl border border-gold-300 bg-gold-100/60 p-6">
          <h2 className="font-serif text-2xl font-semibold">What still depends on trusted actors</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.95rem] leading-relaxed">
            <li>Whether the facts entered (custody dates, conviction history, pending cases) are true.</li>
            <li>Who is granted each role — wallet keys stand in for institutional identity.</li>
            <li>The legal calculation itself, which a lawyer must review. BailBridge never decides bail.</li>
            <li>The court’s actual order. The “Demo issuer” here is a prototype identity, not a court.</li>
          </ul>
        </div>
      </section>

      <section className="rounded-xl border border-paper-200 bg-white p-6">
        <h2 className="font-serif text-2xl font-semibold">About this demo</h2>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-navy-800">
          All people, cases and institutions shown are synthetic; institutional identities are labelled “Demo”. BailBridge is a prototype
          coordination and audit layer intended to complement — not replace or integrate with — official systems such as the Supreme Court’s
          FASTER system for electronic transmission of orders. Nothing on-chain contains names, offences or custody details.
        </p>
        <div className="mt-4 flex flex-wrap gap-4 text-[0.95rem] font-semibold">
          <Link to="/release-clock" className="text-navy-700 underline">
            See the public release clock
          </Link>
          <Link to="/login" className="text-navy-700 underline">
            Sign in with a demo role
          </Link>
        </div>
      </section>
    </div>
  );
}
