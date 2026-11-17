// Public types for geojson-vt

import type {GeoJSON} from 'geojson';

// Constructor input: every field is optional and falls back to its default. The resolved set of
// options, with defaults filled in, is what `GeoJSONVT.options` exposes.
export interface Options {
    maxZoom?: number;
    indexMaxZoom?: number;
    indexMaxPoints?: number;
    tolerance?: number;
    extent?: number;
    buffer?: number;
    lineMetrics?: boolean;
    promoteId?: string | null;
    generateId?: boolean;
    debug?: 0 | 1 | 2;
}

export interface TileCoord { z: number; x: number; y: number; }

// Reverse-index lookup of one source feature. `bbox` is [minX, minY, maxX, maxY] in the original
// GeoJSON longitude/latitude space; `tiles` is the ascending list of generated tiles (drill-downs
// included) that actually contain a slice of the feature.
export interface FeatureInfo {
    id: number | string;
    type: 'Point' | 'LineString' | 'Polygon';
    tags: Record<string, unknown> | null;
    bbox: [number, number, number, number];
    tiles: TileCoord[];
}

// Legacy nested envelope returned by getTile(). Coords are extent-scaled ints
// in tile space. `tags` (not `properties`) matches Supercluster and gl-js's
// geojson_rt.ts for cross-library envelope consistency.
export type LegacyFeature = {
    id?: number | string;
    tags: Record<string, unknown> | null;
} & ({
    type: 1;
    geometry: [number, number][];
} | {
    type: 2 | 3;
    geometry: [number, number][][];
});

export interface LegacyTile {
    features: LegacyFeature[];
}

// Zero-copy view of the tile as stored: flat [x, y, x, y, …] typed arrays, one per ring. Point features
// come in two shapes — a lone point keeps its coords inline (type 4), a multi-point gets one array.
export type RawFeature = {
    id?: number | string;
    tags: Record<string, unknown> | null | undefined;
} & ({
    type: 4;
    x: number;
    y: number;
} | {
    type: 1;
    geometry: Int16Array | Int32Array;
} | {
    type: 2 | 3;
    geometry: (Int16Array | Int32Array)[];
});

export interface RawTile {
    readonly features: readonly RawFeature[];
}

export default class GeoJSONVT {
    constructor(data: GeoJSON, options?: Options);
    options: Readonly<Required<Options>>;
    tileCoords: TileCoord[];
    getTile(z: number | string, x: number | string, y: number | string): LegacyTile | null;
    getTileRaw(z: number | string, x: number | string, y: number | string): RawTile | null;
    // Reverse lookup: metadata and the tiles containing the feature with `id`, or null when no source
    // feature carries that id.
    getFeature(id: number | string): FeatureInfo | null;
    // Sorted ids known to the reverse index — numbers (numeric order) before strings (lexicographic).
    getFeatureIds(): Array<number | string>;
}
