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

  // Every state before the board is its own page, so each one carries the main
  // landmark and the product name as its heading. The board replaces that
  // heading with the status being read, which is the subject of that page.
  if (state.status === "loading") {
    return (
      <main className="gate">
        <h1 className="gate__title">PocketBoard</h1>
        <p className="gate__text" role="status">
          Checking your session…
        </p>
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="gate">
        <h1 className="gate__title">PocketBoard</h1>
        <p className="gate__alert" role="alert">
          Could not check your session.
        </p>
        <button type="button" className="gate__retry" onClick={load}>
          Try again
        </button>
      </main>
    );
  }

  if (state.status === "unauthenticated") {
    return (
      <main className="gate">
        <h1 className="gate__title">PocketBoard</h1>
        <p className="gate__text">Sign in to see your board.</p>
        <a className="gate__link" href={signInUrl}>
          Sign in with GitHub
        </a>
      </main>
    );
  }

  if (state.status === "denied") {
    return (
      <main className="gate">
        <h1 className="gate__title">PocketBoard</h1>
        <p className="gate__alert" role="alert">
          This GitHub account does not have access to this board.
        </p>
        <a className="gate__link" href={signInUrl}>
          Sign in with a different account
        </a>
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
    <div className="app">
      <header className="app__header">
        <p className="app__product">PocketBoard</p>
        <button type="button" className="app__signout" onClick={handleSignOut}>
          Sign out
        </button>
      </header>
      <Board csrfToken={state.session.csrfToken} onAuthLost={load} />
    </div>
  );
}
