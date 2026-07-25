import type Database from "better-sqlite3";
import type { AmbientModelRuntimeCatalog } from "../../shared/ambientModels";
import {
  AMBIENT_DEFAULT_MODEL,
  normalizeAmbientModelId,
} from "../../shared/ambientModels";
import {
  applyAmbientFeatureFlagSettingsPatch,
  DEFAULT_AMBIENT_FEATURE_FLAG_SETTINGS,
  normalizeAmbientFeatureFlagSettings,
  type AmbientFeatureFlagSettings,
  type UpdateFeatureFlagSettingsInput,
} from "../../shared/featureFlags";
import {
  applyAgentMemorySettingsPatch,
  DEFAULT_AGENT_MEMORY_SETTINGS,
  normalizeAgentMemorySettings,
  type AgentMemorySettings,
  type UpdateAgentMemorySettingsInput,
} from "../../shared/agentMemorySettings";
import {
  DEFAULT_MODEL_RUNTIME_SETTINGS,
  modelRuntimeProfilesFromSettings,
  modelRuntimeProvidersFromSettings,
  normalizeModelRuntimeSettings,
} from "../../shared/modelRuntimeSettings";
import type { AmbientCompactionSettings, CollaborationMode, ModelRuntimeSettings, ThinkingLevel } from "../../shared/threadTypes";
import type { DesktopSettings } from "../../shared/desktopTypes";
import type { PermissionMode } from "../../shared/permissionTypes";
import { defaultLocalDeepResearchSettings } from "./projectStoreLocalDeepResearchFacade";
import { createModelRuntimeCatalog } from "./projectStoreModelProviderFacade";
import { migrateProjectStorePermissionModeDefaultsToWorkspace } from "./projectStoreSchema";
import { DEFAULT_COMPACTION_SETTINGS, normalizeCompactionSettings } from "./projectStoreSettings";

const MODEL_RUNTIME_TIMEOUT_DEFAULTS_VERSION_KEY = "modelRuntimeTimeoutDefaultsVersion";
const CURRENT_MODEL_RUNTIME_TIMEOUT_DEFAULTS_VERSION = 2;
const LEGACY_MODEL_RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 30_000;

export class ProjectStoreSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  ensureDefaultSettings(): void {
    const defaults: Record<string, unknown> = {
      permissionMode: "workspace",
      model: AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "xhigh",
      memory: DEFAULT_AGENT_MEMORY_SETTINGS,
      modelRuntime: DEFAULT_MODEL_RUNTIME_SETTINGS,
      automationAutoDispatchEnabled: true,
    };
    for (const [key, value] of Object.entries(defaults)) {
      this.db
        .prepare("INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)")
        .run(key, JSON.stringify(value));
    }
    migrateProjectStorePermissionModeDefaultsToWorkspace(this.db);
  }

  getDefaultSettings(): DesktopSettings {
    return {
      permissionMode: this.getSetting("permissionMode", "workspace") as PermissionMode,
      collaborationMode: this.getSetting("collaborationMode", "agent") as CollaborationMode,
      model: normalizeAmbientModelId(this.getSetting("model", AMBIENT_DEFAULT_MODEL) as string),
      featureFlags: this.getFeatureFlagSettings(),
      memory: this.getMemorySettings(),
      thinkingLevel: this.getSetting("thinkingLevel", "xhigh") as ThinkingLevel,
      thinkingDisplay: { mode: "transient", hideRunStatusCardAfterFirstMessage: true },
      modelRuntime: this.getModelRuntimeSettings(),
      modelCatalog: this.getModelRuntimeCatalog(),
      compaction: this.getCompactionSettings(),
      media: { generatedMediaAutoplay: false },
      planner: { autoFinalize: true },
      search: {},
      localDeepResearch: defaultLocalDeepResearchSettings(),
      voice: {
        enabled: false,
        mode: "assistant-final",
        autoplay: false,
        maxChars: 1500,
        longReply: "summarize",
        format: "mp3",
        artifactCacheMaxMb: 30,
      },
      stt: {
        enabled: false,
        spokenLanguage: "English",
        microphone: {},
        mode: "push-to-talk",
        autoSendAfterTranscription: true,
        silenceFinalizeSeconds: 0.8,
        noSpeechGate: {
          enabled: true,
          rmsThresholdDbfs: -55,
        },
        bargeIn: {
          stopTtsOnSpeech: true,
          queueWhileAgentRuns: true,
        },
      },
    };
  }

  getCompactionSettings(): AmbientCompactionSettings {
    return normalizeCompactionSettings(this.getSetting("compaction", DEFAULT_COMPACTION_SETTINGS));
  }

  setCompactionSettings(input: Partial<AmbientCompactionSettings>): AmbientCompactionSettings {
    const next = normalizeCompactionSettings({ ...this.getCompactionSettings(), ...input });
    this.setSetting("compaction", next);
    return next;
  }

  getModelRuntimeSettings(): ModelRuntimeSettings {
    const settings = normalizeModelRuntimeSettings(this.getSetting("modelRuntime", DEFAULT_MODEL_RUNTIME_SETTINGS));
    const timeoutDefaultsVersion = Number(this.getSetting(MODEL_RUNTIME_TIMEOUT_DEFAULTS_VERSION_KEY, 0));
    if (timeoutDefaultsVersion >= CURRENT_MODEL_RUNTIME_TIMEOUT_DEFAULTS_VERSION) return settings;

    const migrated = settings.providerStreamIdleTimeoutMs === LEGACY_MODEL_RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT_MS
      ? { ...settings, providerStreamIdleTimeoutMs: DEFAULT_MODEL_RUNTIME_SETTINGS.providerStreamIdleTimeoutMs }
      : settings;
    this.setSetting("modelRuntime", migrated);
    this.setSetting(MODEL_RUNTIME_TIMEOUT_DEFAULTS_VERSION_KEY, CURRENT_MODEL_RUNTIME_TIMEOUT_DEFAULTS_VERSION);
    return migrated;
  }

  setModelRuntimeSettings(input: Partial<ModelRuntimeSettings>): ModelRuntimeSettings {
    const next = normalizeModelRuntimeSettings({ ...this.getModelRuntimeSettings(), ...input });
    this.setSetting("modelRuntime", next);
    return next;
  }

  getModelRuntimeCatalog(generatedAt?: string, runtimeProfiles: readonly AmbientModelRuntimeCatalog["profiles"][number][] = []): AmbientModelRuntimeCatalog {
    const settings = this.getModelRuntimeSettings();
    return createModelRuntimeCatalog({
      generatedAt,
      providers: modelRuntimeProvidersFromSettings(settings),
      runtimeProfiles: [
        ...modelRuntimeProfilesFromSettings(settings),
        ...runtimeProfiles,
      ],
    });
  }

  getFeatureFlagSettings(): AmbientFeatureFlagSettings {
    return normalizeAmbientFeatureFlagSettings(
      this.getSetting("featureFlags", DEFAULT_AMBIENT_FEATURE_FLAG_SETTINGS) as Partial<AmbientFeatureFlagSettings>,
    );
  }

  setFeatureFlagSettings(input: UpdateFeatureFlagSettingsInput): AmbientFeatureFlagSettings {
    const next = applyAmbientFeatureFlagSettingsPatch(this.getFeatureFlagSettings(), input);
    this.setSetting("featureFlags", next);
    return next;
  }

  getMemorySettings(): AgentMemorySettings {
    return normalizeAgentMemorySettings(
      this.getSetting("memory", DEFAULT_AGENT_MEMORY_SETTINGS) as Partial<AgentMemorySettings>,
    );
  }

  setMemorySettings(input: UpdateAgentMemorySettingsInput): AgentMemorySettings {
    const next = applyAgentMemorySettingsPatch(this.getMemorySettings(), input);
    this.setSetting("memory", next);
    return next;
  }

  getAutomationAutoDispatchEnabled(): boolean {
    const value = this.getSetting("automationAutoDispatchEnabled", true);
    return typeof value === "boolean" ? value : true;
  }

  setAutomationAutoDispatchEnabled(enabled: boolean): void {
    this.setSetting("automationAutoDispatchEnabled", enabled);
  }

  isPluginEnabled(pluginId: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM plugin_settings WHERE plugin_id = ?").get(pluginId) as
      | { enabled: number }
      | undefined;
    return row ? row.enabled === 1 : true;
  }

  setPluginEnabled(pluginId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO plugin_settings (plugin_id, enabled, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(pluginId, enabled ? 1 : 0, new Date().toISOString());
  }

  isPluginTrusted(pluginId: string, pluginFingerprint?: string): boolean {
    const row = this.db.prepare("SELECT plugin_id, fingerprint FROM plugin_trust WHERE plugin_id = ?").get(pluginId) as
      | { plugin_id: string; fingerprint: string | null }
      | undefined;
    if (!row) return false;
    if (pluginFingerprint === undefined) return true;
    return row.fingerprint === pluginFingerprint;
  }

  setPluginTrusted(pluginId: string, trusted: boolean, pluginFingerprint?: string): void {
    if (!trusted) {
      this.db.prepare("DELETE FROM plugin_trust WHERE plugin_id = ?").run(pluginId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO plugin_trust (plugin_id, fingerprint, trusted_at)
         VALUES (?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET fingerprint = excluded.fingerprint, trusted_at = excluded.trusted_at`,
      )
      .run(pluginId, pluginFingerprint ?? null, new Date().toISOString());
  }

  isPiPackageEnabled(packageId: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM plugin_settings WHERE plugin_id = ?").get(piPackageSettingId(packageId)) as
      | { enabled: number }
      | undefined;
    return row ? row.enabled === 1 : false;
  }

  setPiPackageEnabled(packageId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO plugin_settings (plugin_id, enabled, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(piPackageSettingId(packageId), enabled ? 1 : 0, new Date().toISOString());
  }

  clearPiPackageEnabled(packageId: string): void {
    this.db.prepare("DELETE FROM plugin_settings WHERE plugin_id = ?").run(piPackageSettingId(packageId));
  }

  getSetting(key: string, fallback: unknown): unknown {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }
}

function piPackageSettingId(packageId: string): string {
  return `pi-package:${packageId}`;
}
