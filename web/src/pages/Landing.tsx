import { Link } from "react-router-dom";

// Full landing page arrives with the docs session; this keeps the route usable meanwhile.
export function Landing() {
  return (
    <div className="space-y-4">
      <h1 className="font-serif text-4xl font-semibold">BailBridge</h1>
      <p className="text-lg">From detention threshold to verified release.</p>
      <Link to="/login" className="inline-block rounded-lg bg-navy-800 px-4 py-2.5 font-semibold text-white">
        Open the demo
      </Link>
    </div>
  );
}
