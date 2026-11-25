import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { ApiError, login, type Persona, type QrCode } from "./api";

export interface SessionState {
  personas: Record<string, Persona>;
  activeId: string | null;
  qrs: QrCode[];
}

export type SessionAction =
  | { type: "upsert"; persona: Persona; activate?: boolean }
  | { type: "remove"; userId: string }
  | { type: "activate"; userId: string }
  | { type: "addQr"; qr: QrCode };

const KEY = "ecash.session.v1";
const empty: SessionState = { personas: {}, activeId: null, qrs: [] };

export function reducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case "upsert":
      return {
        ...s,
        personas: { ...s.personas, [a.persona.userId]: a.persona },
        activeId: a.activate || s.activeId === null ? a.persona.userId : s.activeId,
      };
    case "remove": {
      const { [a.userId]: _gone, ...rest } = s.personas;
      return { ...s, personas: rest, activeId: s.activeId === a.userId ? (Object.keys(rest)[0] ?? null) : s.activeId };
    }
    case "activate":
      return s.personas[a.userId] ? { ...s, activeId: a.userId } : s;
    case "addQr":
      return { ...s, qrs: [a.qr, ...s.qrs.filter((q) => q.qrId !== a.qr.qrId)].slice(0, 20) };
  }
}

function load(): SessionState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<SessionState>;
    return { personas: p.personas ?? {}, activeId: p.activeId ?? null, qrs: p.qrs ?? [] };
  } catch {
    return empty;
  }
}

interface Ctx {
  state: SessionState;
  dispatch: (a: SessionAction) => void;
  active: Persona | null;
  /** Runs `fn` with the persona's token; on 401 re-logs in with its MPIN once and retries. */
  callAs: <T>(userId: string, fn: (token: string) => Promise<T>) => Promise<T>;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: session lives in memory only */
    }
  }, [state]);

  const callAs = useCallback(async <T,>(userId: string, fn: (token: string) => Promise<T>): Promise<T> => {
    const p = stateRef.current.personas[userId];
    if (!p) throw new ApiError("NO_PERSONA", 0, "Unknown persona");
    try {
      return await fn(p.token);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      const fresh = await login(p.mobile, p.mpin);
      dispatch({ type: "upsert", persona: { ...p, token: fresh.token } });
      return fn(fresh.token);
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({ state, dispatch, active: state.activeId ? (state.personas[state.activeId] ?? null) : null, callAs }),
    [state, callAs],
  );
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
