import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type AircraftAssetCategory,
  type AircraftAssetMetadata,
  aircraftAssetMetadataSchema,
} from "@agentic-three/shared";
import { projectRoot } from "./memory.js";

const ASSETS_ROOT = resolve(projectRoot, "assets", "aircraft");

export type AircraftAssetRecord = AircraftAssetMetadata & {
  metadataPath: string;
  hasModel: boolean;
  hasPreview: boolean;
};

export function listAircraftAssets(category?: AircraftAssetCategory): AircraftAssetRecord[] {
  if (!existsSync(ASSETS_ROOT)) return [];
  const metadataFiles = findMetadataFiles(ASSETS_ROOT);
  return metadataFiles
    .map((metadataPath) => readAssetMetadata(metadataPath))
    .filter((asset): asset is AircraftAssetRecord => Boolean(asset))
    .filter((asset) => !category || asset.category === category)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getAircraftAsset(id: string): AircraftAssetRecord | undefined {
  return listAircraftAssets().find((asset) => asset.id === id);
}

function readAssetMetadata(metadataPath: string): AircraftAssetRecord | undefined {
  try {
    const parsed = aircraftAssetMetadataSchema.parse(JSON.parse(readFileSync(metadataPath, "utf8")));
    return {
      ...parsed,
      metadataPath: relative(projectRoot, metadataPath).replace(/\\/g, "/"),
      hasModel: existsSync(resolve(projectRoot, parsed.assetPath)),
      hasPreview: existsSync(resolve(projectRoot, parsed.previewPath)),
    };
  } catch (error) {
    console.warn("[agentic-three:assets] invalid metadata", {
      metadataPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function findMetadataFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name === "metadata.json") result.push(fullPath);
    }
  };
  visit(root);
  return result;
}
