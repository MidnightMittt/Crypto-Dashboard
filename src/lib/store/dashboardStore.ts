"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AlertRule, AssetSymbol } from "@/types/market";

interface DashboardState {
  asset: AssetSymbol | "MARKET";
  setAsset: (a: AssetSymbol | "MARKET") => void;

  soundEnabled: boolean;
  toggleSound: () => void;

  rules: AlertRule[];
  addRule: (rule: AlertRule) => void;
  removeRule: (id: string) => void;
  toggleRule: (id: string) => void;
  markTriggered: (id: string) => void;
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      asset: "BTC",
      setAsset: (asset) => set({ asset }),

      soundEnabled: false,
      toggleSound: () => set((s) => ({ soundEnabled: !s.soundEnabled })),

      rules: [],
      addRule: (rule) => set((s) => ({ rules: [rule, ...s.rules] })),
      removeRule: (id) => set((s) => ({ rules: s.rules.filter((r) => r.id !== id) })),
      toggleRule: (id) =>
        set((s) => ({
          rules: s.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
        })),
      markTriggered: (id) =>
        set((s) => ({
          rules: s.rules.map((r) => (r.id === id ? { ...r, lastTriggeredAt: Date.now() } : r)),
        })),
    }),
    { name: "leverage-terminal-store" }
  )
);
