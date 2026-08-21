"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from "@/lib/prefs/prefs";
import { soundPlayer } from "@/lib/sound/player";

interface PrefsContextValue {
  prefs: Prefs;
  update(partial: Partial<Prefs>): void;
}

const PrefsContext = createContext<PrefsContextValue>({
  prefs: DEFAULT_PREFS,
  update: () => undefined,
});

export function usePrefs(): PrefsContextValue {
  return useContext(PrefsContext);
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    const stored = loadPrefs();
    // B2.6: system reduced-motion is a proxy for reduced-sensory preference —
    // first visits under it start muted (an explicit stored choice wins).
    const hasStored = (() => {
      try {
        return localStorage.getItem("gambit.prefs.v1") !== null;
      } catch {
        return false;
      }
    })();
    if (!hasStored && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      stored.sound = { ...stored.sound, muted: true };
    }
    setPrefs(stored);
  }, []);

  // Reflect the animation preference for the CSS motion tokens.
  useEffect(() => {
    const effective = prefs.accessibility.reduceMotion ? "instant" : prefs.animation;
    document.documentElement.dataset.anim = effective;
  }, [prefs.animation, prefs.accessibility.reduceMotion]);

  // Sounds decode on the first gesture (never before — B2.6).
  useEffect(() => {
    const load = () => void soundPlayer().ensureLoaded();
    window.addEventListener("pointerdown", load, { once: true });
    window.addEventListener("keydown", load, { once: true });
    return () => {
      window.removeEventListener("pointerdown", load);
      window.removeEventListener("keydown", load);
    };
  }, []);

  const update = useCallback((partial: Partial<Prefs>) => {
    setPrefs((previous) => {
      const next = { ...previous, ...partial };
      savePrefs(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, update }), [prefs, update]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}
