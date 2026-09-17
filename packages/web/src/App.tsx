import { AuthGate } from "./components/AuthGate";
import { PrototypeBoardRoute, prototypeBoardPath } from "./prototype/PrototypeBoardRoute";

export function App() {
  // The throwaway board-UI prototype, and nothing else, lives behind this gate.
  // Vite substitutes `false` for import.meta.env.DEV in a production build, so
  // the branch is statically dead and the prototype module is dropped from the
  // bundle entirely: /prototype/board falls through to AuthGate in production,
  // exactly like any other unknown path.
  if (import.meta.env.DEV && window.location.pathname === prototypeBoardPath) {
    return <PrototypeBoardRoute />;
  }
  return <AuthGate />;
}
