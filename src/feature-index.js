
/** @import {FeatureId, Tags, FeatureIndexEntry, GeoJsonType} from './internal.d.ts' */
/** @import {FeatureInfo, TileCoord} from './index.d.ts' */
/** @import {Geometry} from 'geojson' */

// Reverse feature index: maps a source-feature id to the GeoJSON metadata (type/tags/bbox) and the
// packed ids of every retained tile that contains a slice of the feature. Built in two phases:
//   1. `register` runs once per source feature during convert() — duplicate ids across distinct source
//      features fail loudly, while re-registration of the same feature (GeometryCollection recursion,
//      Int32-overflow reconversion) is a no-op.
//   2. `addTile` runs whenever splitTile materializes a new tile, including drill-downs. Repeated
//      lookups of an already-built tile never reach here, so each tile id is appended at most once.
//
// Keys are the id values themselves in a Map: numeric `1` and string `'1'` hash to distinct slots, so
// they are never conflated. Tile coords live in a plain packed-integer array per entry, not a Set — a
// feature spans few tiles, so a linear tail scan is cheaper than allocating a Set per feature, and it
// keeps getFeature within its O(k) budget. The ids are only expanded into {z, x, y} objects on read.

/** @param {number} z @param {number} x @param {number} y */
export function tileToID(z, x, y) {
    return (((1 << z) * y + x) * 32) + z;
}

/** @param {number} id @returns {TileCoord} */
function tileFromID(id) {
    const z = id % 32;
    const n = (id - z) / 32;
    return {z, x: n & ((1 << z) - 1), y: n >> z};
}

export default class FeatureIndex {
    constructor() {
        /** @type {Map<FeatureId, FeatureIndexEntry>} */
        this.entries = new Map();
        // Stays false until the first id-bearing feature registers; the tile hot path checks this
        // and skips the index entirely for data without ids.
        this.active = false;
        /** @type {FeatureId[]|null} */
        this._sortedIds = null;
    }

    // Index one source feature. `sourceToken` identifies the source feature itself (its position in the
    // FeatureCollection) so geometry paths that emit several internal features share one entry instead
    // of tripping the duplicate-id guard. The GeoJSON type/lng-lat bbox scan only runs for id-bearing
    // features — anonymous data takes the early return and never touches the geometry.
    /** @param {FeatureId|undefined} id @param {Geometry} geom @param {Tags} tags @param {number} sourceToken */
    register(id, geom, tags, sourceToken) {
        if (id == null || (typeof id !== 'number' && typeof id !== 'string')) return;

        let entry = this.entries.get(id);
        if (entry === undefined) {
            const meta = geoMeta(geom);
            if (!meta) return; // empty GeometryCollection: produces no internal features
            entry = {
                id,
                type: meta.type,
                tags: tags ?? null,
                // bbox kept as flat fields rather than a nested array — one fewer allocation per source
                // feature on the build hot path; getFeature assembles the public [minX,minY,maxX,maxY].
                minX: meta.bbox[0],
                minY: meta.bbox[1],
                maxX: meta.bbox[2],
                maxY: meta.bbox[3],
                sourceToken,
                /** @type {number[]} packed tile ids, appended at most once per materialized tile */
                tileIDs: [],
                /** @type {TileCoord[]|null} */
                sortedTiles: null
            };
            this.entries.set(id, entry);
            this.active = true;
            this._sortedIds = null;
        } else if (entry.sourceToken !== sourceToken) {
            throw new Error('duplicate feature id');
        }
    }

    // Record every id-bearing feature retained in a freshly materialized tile. TileFeature.id is only
    // set when the source feature had an id, so the lookup misses for anonymous features. The linear
    // duplicate scan is O(k) over the few tiles a feature spans; each materialized tile reaches here
    // once, so a given packed id is appended at most once.
    /** @param {import('./internal.d.ts').TileFeature[]} features @param {number} z @param {number} x @param {number} y */
    addTile(features, z, x, y) {
        if (!this.active) return;
        const packed = tileToID(z, x, y);
        for (const feature of features) {
            if (feature.id === undefined) continue;
            const entry = this.entries.get(feature.id);
            if (entry === undefined) continue;
            const ids = entry.tileIDs;
            let seen = false;
            for (let i = 0; i < ids.length; i++) {
                if (ids[i] === packed) { seen = true; break; }
            }
            if (!seen) {
                ids.push(packed);
                entry.sortedTiles = null; // lazy re-sort on the next getFeature()
            }
        }
    }

    /** @param {FeatureId} id @returns {FeatureInfo|null} */
    getFeature(id) {
        const entry = this.entries.get(id);
        if (entry === undefined) return null;

        if (entry.sortedTiles === null) {
            entry.sortedTiles = [...entry.tileIDs].map(tileFromID)
                .sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
        }

        return {
            id: entry.id,
            type: entry.type,
            tags: entry.tags ?? null,
            bbox: [entry.minX, entry.minY, entry.maxX, entry.maxY],
            tiles: entry.sortedTiles.map(t => ({z: t.z, x: t.x, y: t.y}))
        };
    }

    // Deterministic ordering across mixed id types: all numbers first (numeric order), then strings
    // (lexicographic). The result is cached until a new id registers (never happens after construction).
    /** @returns {FeatureId[]} */
    getFeatureIds() {
        if (this._sortedIds === null) {
            this._sortedIds = [...this.entries.keys()].sort((a, b) => {
                if (typeof a === 'number') {
                    return typeof b === 'number' ? a - b : -1;
                }
                if (typeof b === 'number') return 1;
                return a < b ? -1 : a > b ? 1 : 0;
            });
        }
        return [...this._sortedIds];
    }
}

// Original GeoJSON type name and lng/lat bbox for a source geometry. Multi* geometries collapse to their
// singular base type (Point / LineString / Polygon). Returns null when every part of a GeometryCollection
// is empty — such a feature produces no internal features and must not be indexed. Flat index loops
// (no for-of / closure per ring) keep this off the convert hot path's critical budget.
/** @param {Geometry} geom @returns {{type: GeoJsonType, bbox: [number, number, number, number]}|null} */
function geoMeta(geom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    /** @type {GeoJsonType|null} */
    let type = null;

    // Scan one coordinate ring (array of [x, y]).
    /** @param {number[][]} ring */
    const scanRing = (ring) => {
        for (let i = 0; i < ring.length; i++) {
            const x = ring[i][0], y = ring[i][1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    };

    switch (geom.type) {
    case 'Point': {
        type = 'Point';
        const c = geom.coordinates;
        minX = maxX = c[0];
        minY = maxY = c[1];
        break;
    }
    case 'MultiPoint': {
        type = 'Point';
        const pts = geom.coordinates;
        for (let i = 0; i < pts.length; i++) {
            const x = pts[i][0], y = pts[i][1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        break;
    }
    case 'LineString':
        type = 'LineString';
        scanRing(geom.coordinates);
        break;
    case 'MultiLineString':
        type = 'LineString';
        for (let i = 0; i < geom.coordinates.length; i++) scanRing(geom.coordinates[i]);
        break;
    case 'Polygon':
        type = 'Polygon';
        for (let i = 0; i < geom.coordinates.length; i++) scanRing(geom.coordinates[i]);
        break;
    case 'MultiPolygon':
        type = 'Polygon';
        for (let p = 0; p < geom.coordinates.length; p++) {
            const polygon = geom.coordinates[p];
            for (let r = 0; r < polygon.length; r++) scanRing(polygon[r]);
        }
        break;
    case 'GeometryCollection':
        for (let i = 0; i < geom.geometries.length; i++) {
            const meta = geoMeta(geom.geometries[i]);
            if (!meta) continue;
            if (type === null) type = meta.type;
            const b = meta.bbox;
            if (b[0] < minX) minX = b[0];
            if (b[1] < minY) minY = b[1];
            if (b[2] > maxX) maxX = b[2];
            if (b[3] > maxY) maxY = b[3];
        }
        break;
    default:
        return null;
    }

    return type === null || !Number.isFinite(minX) ? null : {type, bbox: [minX, minY, maxX, maxY]};
}
