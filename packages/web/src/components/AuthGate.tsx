import { useCallback, useEffect, useState } from "react";
import { fetchSession, logout, signInUrl, type SessionState } from "../api/client";
import { Board } from "./Board";

type GateState = SessionState | { status: "loading" } | { status: "error" };

export function AuthGate() {
  const [state, setState] = useState<GateState>({ status: "loading" });

  const load = useCallback(() => {
    fetchSession()
      .then(setState)
      .catch(() => setState({ status: "error" }));
  }, []);

  useEffect(load, [load]);

  if (state.status === "loading") {
    return <p role="status">Checking your session…</p>;
  }

  if (state.status === "error") {
    return (
      <div role="alert">
        <p>Could not check your session.</p>
        <button type="button" onClick={load}>
          Try again
        </button>
      </div>
    );
  }

  if (state.status === "unauthenticated") {
    return (
      <main>
        <h1>PocketBoard</h1>
        <p>Sign in to see your board.</p>
        <a href={signInUrl}>Sign in with GitHub</a>
      </main>
    );
  }

  if (state.status === "denied") {
    return (
      <main>
        <h1>PocketBoard</h1>
        <p role="alert">This GitHub account does not have access to this board.</p>
        <a href={signInUrl}>Sign in with a different account</a>
      </main>
    );
  }

  async function handleSignOut() {
    if (state.status !== "authenticated") {
      return;
    }
    try {
      await logout(state.session.csrfToken);
    } finally {
      // Whether or not the request succeeded, re-read the real session state
      // rather than assuming the browser is now signed out.
      load();
    }
  }

  return (
    <>
      <header>
        <button type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>
      <Board csrfToken={state.session.csrfToken} onAuthLost={load} />
    </>
  );
}
