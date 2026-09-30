import { Bug, CircleAlert, CircleCheck, Construction, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

type HealthState = { kind: 'loading' } | { kind: 'ok' } | { kind: 'error'; message: string };

function useServiceHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json();
        const ok =
          response.ok && typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok';
        setState(ok ? { kind: 'ok' } : { kind: 'error', message: `HTTP ${response.status}` });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => controller.abort();
  }, []);

  return state;
}

function HealthIndicator({ state }: { state: HealthState }) {
  switch (state.kind) {
    case 'loading':
      return (
        <p className="health" data-testid="health">
          <LoaderCircle aria-hidden size={16} className="spin" /> Checking service health…
        </p>
      );
    case 'ok':
      return (
        <p className="health health-ok" data-testid="health">
          <CircleCheck aria-hidden size={16} /> Service health endpoint responded: ok
        </p>
      );
    case 'error':
      return (
        <p className="health health-error" data-testid="health">
          <CircleAlert aria-hidden size={16} /> Service health endpoint unavailable ({state.message})
        </p>
      );
  }
}

export function App() {
  const health = useServiceHealth();

  return (
    <main className="page">
      <header className="title">
        <Bug aria-hidden size={32} />
        <h1>Bug Smasher</h1>
      </header>
      <section className="notice" aria-labelledby="notice-heading">
        <h2 id="notice-heading">
          <Construction aria-hidden size={20} /> No web dashboard yet
        </h2>
        <p>
          Bug Smasher works in GitHub: a person adds a label, Devin investigates and fixes, and a person decides
          and merges there. The service's figures are at <code>/api/overview</code> and <code>/api/metrics</code>,
          and the dashboard pages are in the repository's <code>results/</code> folder.
        </p>
      </section>
      <HealthIndicator state={health} />
    </main>
  );
}
