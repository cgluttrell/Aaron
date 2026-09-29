// Target resolver combines plugin id heuristics, cached directory searches,
// live fallback lookups, and normalized fallback targets.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelId,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { captureChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { buildDirectoryCacheKey, DirectoryCache } from "./directory-cache.js";
// Message CLI actions use scoped registries without activating the process-root registry.
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";
import {
  ambiguousTargetError,
  missingTargetError,
  reservedTargetLiteralError,
  unknownTargetError,
} from "./target-errors.js";
import { maybeResolveIdLikeTarget } from "./target-id-resolution.js";
import {
  buildTargetResolverSignature,
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
  resolveReservedTargetLiteral,
  type ResolvedPluginMessagingTarget,
} from "./target-normalization.js";

export type ResolvedMessagingTarget = Omit<ResolvedPluginMessagingTarget, "resolutionSource"> & {
  resolutionSource: "plugin" | "directory" | "normalized";
};

/** Result of resolving a user-supplied outbound target. */
type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | { ok: false; error: Error; candidates?: ChannelDirectoryEntry[] };

export { maybeResolveIdLikeTarget } from "./target-id-resolution.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

/** Clears cached directory entries for all channels or one channel/account scope. */
export function resetDirectoryCache(params?: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
}) {
  if (!params) {
    directoryCache.clear();
    return;
  }
  const channelKey = params.channel;
  const accountKey = params.accountId ?? "default";
  directoryCache.clearMatching(
    (key) =>
      key.startsWith(`${channelKey}:`) &&
      (!params.accountId || key.startsWith(`${channelKey}:${accountKey}:`)),
    params.cfg,
  );
}

function stripTargetPrefixes(value: string, channel?: ChannelId, plugin?: ChannelPlugin): string {
  const providerPrefixes = [channel, plugin?.id, ...(plugin?.messaging?.targetPrefixes ?? [])]
    .map((prefix) => prefix?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  let target = value.trim();
  while (target) {
    const lowered = target.toLowerCase();
    const prefix = providerPrefixes.find((candidate) => lowered.startsWith(`${candidate}:`));
    if (!prefix) {
      break;
    }
    target = target.slice(prefix.length + 1).trim();
  }
  return target
    .replace(/^(channel|group|user):/i, "")
    .replace(/^[@#]/, "")
    .trim();
}

/** Formats a resolved target for user-facing summaries. */
export function formatTargetDisplay(params: {
  channel: ChannelId;
  target: string;
  display?: string;
  kind?: ChannelDirectoryEntryKind;
}): string {
  const plugin = getRuntimeVisibleChannelPlugin(params.channel);
  if (plugin?.messaging?.formatTargetDisplay) {
    return plugin.messaging.formatTargetDisplay({
      target: params.target,
      display: params.display,
      kind: params.kind,
    });
  }

  const trimmedTarget = params.target.trim();
  const lowered = trimmedTarget.toLowerCase();
  const display = params.display?.trim();
  const kind =
    params.kind ??
    (lowered.startsWith("user:") ? "user" : lowered.startsWith("channel:") ? "group" : undefined);

  if (display) {
    if (display.startsWith("#") || display.startsWith("@")) {
      return display;
    }
    if (kind === "user") {
      return `@${display}`;
    }
    if (kind === "group" || kind === "channel") {
      return `#${display}`;
    }
    return display;
  }

  if (!trimmedTarget || trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) {
    return trimmedTarget;
  }

  const channelPrefix = `${params.channel}:`;
  const withoutProvider = lowered.startsWith(channelPrefix)
    ? trimmedTarget.slice(channelPrefix.length)
    : trimmedTarget;

  return withoutProvider.replace(/^channel:/i, "#").replace(/^user:/i, "@");
}

function detectTargetKind(
  channel: ChannelId,
  raw: string,
  preferred?: ChannelDirectoryEntryKind,
  plugin?: ChannelPlugin,
): ChannelDirectoryEntryKind {
  if (preferred) {
    return preferred;
  }
  const inferredChatType = (
    plugin ?? getRuntimeVisibleChannelPlugin(channel)
  )?.messaging?.inferTargetChatType?.({
    to: raw,
  });
  if (inferredChatType === "direct") {
    return "user";
  }
  if (inferredChatType === "channel" || inferredChatType === "group") {
    return inferredChatType;
  }

  if (raw.startsWith("@") || /^<@!?/.test(raw) || /^user:/i.test(raw)) {
    return "user";
  }
  if (raw.startsWith("#") || /^channel:/i.test(raw)) {
    return "group";
  }

  const chatTypes = plugin?.capabilities?.chatTypes ?? [];
  if (chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct")) {
    return "user";
  }

  return "group";
}

function normalizeDirectoryEntryId(
  channel: ChannelId,
  entry: ChannelDirectoryEntry,
  plugin?: ChannelPlugin,
): string {
  const normalized = normalizeTargetForProvider(channel, entry.id, plugin);
  return normalized ?? entry.id.trim();
}

function matchesDirectoryEntry(params: {
  channel: ChannelId;
  entry: ChannelDirectoryEntry;
  query: string;
  plugin?: ChannelPlugin;
  matchMode: "exact" | "substring";
}): boolean {
  const query = normalizeLowercaseStringOrEmpty(params.query);
  if (!query) {
    return false;
  }
  const id = stripTargetPrefixes(
    normalizeDirectoryEntryId(params.channel, params.entry, params.plugin),
    params.channel,
    params.plugin,
  );
  const name = params.entry.name
    ? stripTargetPrefixes(params.entry.name, params.channel, params.plugin)
    : "";
  const handle = params.entry.handle
    ? stripTargetPrefixes(params.entry.handle, params.channel, params.plugin)
    : "";
  const candidates = [id, name, handle].map(normalizeLowercaseStringOrEmpty).filter(Boolean);
  return candidates.some(
    (value) => value === query || (params.matchMode === "substring" && value.includes(query)),
  );
}

function resolveMatch(params: {
  channel: ChannelId;
  entries: ChannelDirectoryEntry[];
  query: string;
  plugin?: ChannelPlugin;
  matchMode: "exact" | "substring";
}) {
  const matches = params.entries.filter((entry) =>
    matchesDirectoryEntry({
      channel: params.channel,
      entry,
      query: params.query,
      plugin: params.plugin,
      matchMode: params.matchMode,
    }),
  );
  if (matches.length === 0) {
    return { kind: "none" as const };
  }
  if (matches.length === 1) {
    return { kind: "single" as const, entry: matches[0] };
  }
  return { kind: "ambiguous" as const, entries: matches };
}

async function listDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  query?: string;
  source: "cache" | "live";
  plugin?: ChannelPlugin;
}): Promise<ChannelDirectoryEntry[]> {
  const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
  const directory = plugin?.directory;
  if (!directory) {
    return [];
  }
  const runtime = params.runtime ?? defaultRuntime;
  const useLive = params.source === "live";
  const fn =
    params.kind === "user"
      ? useLive
        ? (directory.listPeersLive ?? directory.listPeers)
        : directory.listPeers
      : useLive
        ? (directory.listGroupsLive ?? directory.listGroups)
        : directory.listGroups;
  if (!fn) {
    return [];
  }
  captureChannelReadAuthority()?.();
  return await fn({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
    query: params.query ?? undefined,
    limit: undefined,
    runtime,
  });
}

async function getDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  query?: string;
  runtime?: RuntimeEnv;
  preferLiveOnMiss?: boolean;
  plugin?: ChannelPlugin;
}): Promise<ChannelDirectoryEntry[]> {
  const signature = buildTargetResolverSignature(params.channel, params.plugin);
  const cacheQuery = normalizeLowercaseStringOrEmpty(params.query ?? "");
  const cacheKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "cache",
    signature,
    query: cacheQuery,
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) {
    return cached;
  }
  const entries = await listDirectoryEntries({
    ...params,
    source: "cache",
  });
  if (entries.length > 0 || !params.preferLiveOnMiss) {
    directoryCache.set(cacheKey, entries, params.cfg);
    return entries;
  }
  // Empty cached directory results may be stale; live lookup gets one chance
  // before both live and cache keys are updated.
  const liveKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "live",
    signature,
    query: cacheQuery,
  });
  const liveEntries = await listDirectoryEntries({
    ...params,
    source: "live",
  });
  directoryCache.set(liveKey, liveEntries, params.cfg);
  directoryCache.set(cacheKey, liveEntries, params.cfg);
  return liveEntries;
}

export async function resolveChannelTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  unknownTargetMode?: "error" | "normalized";
  /** Substring directory matching is opt-in; outbound names are exact by default. */
  directoryMatchMode?: "exact" | "substring";
  plugin?: ChannelPlugin;
}): Promise<ResolveMessagingTargetResult> {
  const raw = params.input.trim();
  const plugin = params.plugin ?? getRuntimeVisibleChannelPlugin(params.channel);
  const providerLabel = plugin?.meta?.label ?? params.channel;
  const hint = plugin?.messaging?.targetResolver?.hint;
  if (!raw) {
    return { ok: false, error: missingTargetError(providerLabel, hint) };
  }
  if (/^(me|self|owner)$/i.test(raw)) {
    return { ok: false, error: reservedTargetLiteralError(providerLabel, raw, hint) };
  }
  const kind = detectTargetKind(params.channel, raw, params.preferredKind, plugin);
  const normalizedInput = resolveNormalizedTargetInput(params.channel, raw, plugin);
  const normalized = normalizedInput?.normalized ?? raw;
  const reservedLiteral = resolveReservedTargetLiteral({ raw, plugin });
  const normalizedResult = (): ResolveMessagingTargetResult => ({
    ok: true,
    target: {
      to: normalized,
      kind,
      display: stripTargetPrefixes(normalized),
      source: "normalized",
      resolutionSource: "normalized",
    },
  });
  const resolvePluginTarget = (requireIdLike?: boolean) =>
    maybeResolvePluginMessagingTarget({ ...params, input: raw, plugin, requireIdLike });
  if (reservedLiteral && plugin?.messaging?.targetResolver?.rejectReservedLiteralMatches) {
    return { ok: false, error: reservedTargetLiteralError(providerLabel, reservedLiteral, hint) };
  }
  if (
    normalizedInput &&
    !reservedLiteral &&
    looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized,
      plugin,
    })
  ) {
    const target = await resolvePluginTarget(true);
    return target ? { ok: true, target } : normalizedResult();
  }
  const query = stripTargetPrefixes(raw, params.channel, plugin);
  const entries = await getDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: kind === "user" ? "user" : "group",
    query,
    runtime: params.runtime,
    preferLiveOnMiss: true,
    plugin,
  });
  const match = resolveMatch({
    channel: params.channel,
    entries,
    query,
    plugin,
    matchMode: reservedLiteral ? "exact" : (params.directoryMatchMode ?? "exact"),
  });
  if (match.kind === "single") {
    const entry = match.entry;
    if (!entry) {
      throw new Error("Single directory match is missing its entry");
    }
    return {
      ok: true,
      target: {
        to: normalizeDirectoryEntryId(params.channel, entry, plugin),
        kind,
        display:
          entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id, params.channel, plugin),
        source: "directory",
        resolutionSource: "directory",
      },
    };
  }
  if (match.kind === "ambiguous") {
    return {
      ok: false,
      error: ambiguousTargetError(providerLabel, raw, hint),
      candidates: match.entries,
    };
  }
  // Directory misses are the fail-closed boundary for reserved literals.
  if (reservedLiteral) {
    return { ok: false, error: reservedTargetLiteralError(providerLabel, reservedLiteral, hint) };
  }
  const resolvedFallbackTarget = await resolvePluginTarget();
  if (resolvedFallbackTarget) {
    return {
      ok: true,
      target: resolvedFallbackTarget,
    };
  }

  if (params.unknownTargetMode === "normalized") {
    return normalizedResult();
  }

  return {
    ok: false,
    error: unknownTargetError(providerLabel, raw, hint),
  };
}

/** Looks up a display label for a resolved target id from cached/live directory entries. */
export async function lookupDirectoryDisplay(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  targetId: string;
  accountId?: string | null;
  runtime?: RuntimeEnv;
}): Promise<string | undefined> {
  const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;

  // Targets can resolve to either peers (DMs) or groups. Try both.
  const [groups, users] = await Promise.all([
    getDirectoryEntries({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      kind: "group",
      runtime: params.runtime,
      preferLiveOnMiss: false,
    }),
    getDirectoryEntries({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      kind: "user",
      runtime: params.runtime,
      preferLiveOnMiss: false,
    }),
  ]);

  const findMatch = (candidates: ChannelDirectoryEntry[]) =>
    candidates.find(
      (candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized,
    );

  const entry = findMatch(groups) ?? findMatch(users);
  return entry?.name ?? entry?.handle ?? undefined;
}
