// Internal types shared across modules. Public types live in index.d.ts.

import type {Options, TileCoord, FeatureInfo} from './index.d.ts';
import type {Geometry} from 'geojson';

// Minimal ambient for console (we don't depend on @types/node and the lib
// doesn't include DOM, which is the usual source of this global).
declare global {
    const console: {
        log(...args: unknown[]): void;
        time(label: string): void;
        timeEnd(label: string): void;
    };
}

export type CoordArray = Int32Array | Float64Array;
export type CoordArrayCtor = Int32ArrayConstructor | Float64ArrayConstructor;
export type TileCoordArray = Int16Array | Int32Array;
export type TileCoordArrayCtor = Int16ArrayConstructor | Int32ArrayConstructor;

export type Tags = Record<string, unknown> | null | undefined;
export type FeatureId = number | string;

// Public GeoJSON geometry name carried by a reverse-index entry. Multi* geometries collapse to their
// singular base type, matching the geometry a source Feature actually names.
export type GeoJsonType = 'Point' | 'LineString' | 'Polygon';

// One reverse-index row: source-feature metadata plus the packed ids of tiles containing its slices.
// `sourceToken` identifies the source feature so GeometryCollection recursion and overflow
// reconversion re-register the same entry instead of tripping the duplicate-id guard.
export interface FeatureIndexEntry {
    id: FeatureId;
    type: GeoJsonType;
    tags: Tags;
    // bbox in original GeoJSON lng/lat, held as flat fields to avoid a nested array per source feature
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    sourceToken: number;
    tileIDs: number[];
    sortedTiles: TileCoord[] | null;
}

// Shape of the FeatureIndex class implemented in feature-index.js.
export declare class FeatureIndex {
    entries: Map<FeatureId, FeatureIndexEntry>;
    active: boolean;
    register(id: FeatureId | undefined, geom: Geometry, tags: Tags, sourceToken: number): void;
    addTile(features: TileFeature[], z: number, x: number, y: number): void;
    getFeature(id: FeatureId): FeatureInfo | null;
    getFeatureIds(): FeatureId[];
}

export type InternalOptions = Required<Options> & {
    useInt32: boolean;
    CoordArray: CoordArrayCtor;
    worldScale: number;
    originShift: number;
};

export interface Feature {
    id?: FeatureId;
    type: 1 | 2 | 3;
    geometry: CoordArray;
    tags: Tags;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    start?: number;
    end?: number;
    size?: number;
}

export interface SinglePointFeature {
    id?: FeatureId;
    type: 4;
    x: number;
    y: number;
    tags: Tags;
}

export type AnyFeature = Feature | SinglePointFeature;

interface TileFeatureBase {
    tags: Tags;
    id?: FeatureId;
}

export interface TileFeatureSinglePoint extends TileFeatureBase {
    type: 4;
    x: number;
    y: number;
}

export interface TileFeaturePoint extends TileFeatureBase {
    type: 1;
    geometry: TileCoordArray;
}

export interface TileFeatureRings extends TileFeatureBase {
    type: 2 | 3;
    geometry: TileCoordArray[];
}

export type TileFeature = TileFeatureSinglePoint | TileFeaturePoint | TileFeatureRings;

export interface Tile {
    features: TileFeature[];
    numPoints: number;
    numSimplified: number;
    numFeatures: number;
    source: AnyFeature[] | null;
    x: number;
    y: number;
    z: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}
