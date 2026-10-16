// Per-tenant plugin state, driven by the merged catalog endpoint
// GET /api/v1/plugins/catalog. Holds the full merged entry list plus catalog
// provenance. Drives the nav-visibility gate, PluginGuard, and the admin
// Plugins settings tab; those three consume enabled/loaded/ensureFetched with
// semantics identical to the pre-catalog store. Enablement writes still go
// through PUT /api/v1/plugins/:id and patch the entry in place. Fetched
// lazily once the authenticated shell mounts.

import { create } from "zustand";
import { api } from "@/api/client";
import { pluginFetch } from "./api";
import {
  type CatalogPluginEntry,
  type CatalogProvenance,
  deriveEnabledIds,
  type VoteOutcome,
} from "./catalog";

interface CatalogResponse {
  data: {
    plugins: CatalogPluginEntry[];
    catalog: CatalogProvenance;
  };
}

interface PluginsState {
  /** Ids of installed and enabled plugins. Nav gating and PluginGuard read
   *  this; unchanged semantics from the pre-catalog store. */
  enabled: string[];
  entries: CatalogPluginEntry[];
  provenance: CatalogProvenance | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Fetch once; no-op if already loaded or in flight. */
  ensureFetched: () => void;
  /** Fetch the merged catalog. force first POSTs the admin refresh endpoint
   *  so the server-side TTL is bypassed. */
  refresh: (opts?: { force?: boolean }) => Promise<void>;
  isEnabled: (id: string) => boolean;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Register demand for a planned plugin. Reports what actually happened, so
   *  the caller can tell a recorded vote from a repeat one from a refusal. */
  vote: (id: string) => Promise<VoteOutcome>;
  /** The self-hoster off switch: clears plugin_catalog_url, then refetches so
   *  provenance reflects the snapshot-only state. */
  turnOff: () => Promise<void>;
  /** Its inverse. Without this, turning the catalog off is a one-way door that
   *  only a settings API call can undo. */
  turnOn: () => Promise<void>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  enabled: [],
  entries: [],
  provenance: null,
  loaded: false,
  loading: false,
  error: null,

  ensureFetched: () => {
    const s = get();
    if (s.loaded || s.loading) return;
    void s.refresh();
  },

  refresh: async (opts = {}) => {
    set({ loading: true });
    try {
      if (opts.force) {
        await pluginFetch("/plugins/catalog/refresh", { method: "POST" });
      }
      const res = await pluginFetch<CatalogResponse>("/plugins/catalog");
      const entries = res.data.plugins;
      set({
        entries,
        provenance: res.data.catalog,
        enabled: deriveEnabledIds(entries),
        loaded: true,
        loading: false,
        error: null,
      });
    } catch (err) {
      // Mark loaded even on failure so guards resolve (deny) instead of spinning.
      set({ loading: false, loaded: true, error: (err as Error).message });
    }
  },

  isEnabled: (id) => get().enabled.includes(id),

  setEnabled: async (id, enabled) => {
    const res = await pluginFetch<{ data: { enabled: string[] } }>(`/plugins/${id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    const enabledIds = res.data.enabled;
    set((s) => ({
      enabled: enabledIds,
      entries: s.entries.map((e) => (e.id === id ? { ...e, enabled } : e)),
    }));
  },

  vote: async (id) => {
    try {
      const res = await pluginFetch<{ data: VoteOutcome }>("/plugins/catalog/vote", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      const outcome = res.data;
      // The endpoint returns the authoritative count for both a fresh and a
      // repeat vote, so adopt it either way rather than incrementing locally.
      if (outcome.count !== null) {
        set((s) => ({
          entries: s.entries.map((e) => (e.id === id ? { ...e, votes: outcome.count! } : e)),
        }));
      }
      return outcome;
    } catch {
      return { count: null, alreadyVoted: false, status: "failed" };
    }
  },

  turnOff: async () => {
    await api.updateSettings({ plugin_catalog_url: "" });
    await get().refresh();
  },

  turnOn: async () => {
    // The backend publishes its own default, so the frontend never has to hold
    // a copy of the URL that could drift from it.
    const url = get().provenance?.defaultUrl;
    if (!url) return;
    await api.updateSettings({ plugin_catalog_url: url });
    await get().refresh({ force: true });
  },
}));
