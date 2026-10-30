import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

/** Providers contributed by enabled plugins whose synthetic auth refs are available. */
export function listSyntheticAuthPluginProviderIds(
  metadataSnapshot: PluginMetadataSnapshot | undefined,
  synthetic: ReadonlySet<string>,
): string[] {
  const providers: string[] = [];
  for (const plugin of metadataSnapshot?.index?.plugins ?? []) {
    if (
      !plugin.enabled ||
      !(plugin.syntheticAuthRefs ?? []).some((ref) =>
        synthetic.has(normalizeProviderIdForAuth(ref)),
      )
    ) {
      continue;
    }
    providers.push(
      ...(plugin.contributions?.providers ?? []),
      ...(plugin.contributions?.modelCatalogProviders ?? []),
    );
  }
  return providers;
}
