
import test from 'node:test';
import assert from 'node:assert/strict';

import GeoJSONVT from '../src/index.js';

// Reverse feature index: source-feature id → GeoJSON metadata + the tiles that contain its slices.
// Tiles are compared against an independent scan of the generated tiles via getTile, the same
// brute-force lookup the index exists to replace.

const pointFeature = (id, coordinates, properties = {}) => ({
    type: 'Feature',
    id,
    properties,
    geometry: {type: 'Point', coordinates}
});

// Ascending {z, x, y} list of tiles whose getTile output carries `id`.
/** @param {GeoJSONVT} index @param {number|string} id @returns {Array<{z:number,x:number,y:number}>} */
function scanTiles(index, id) {
    const found = [];
    for (const {z, x, y} of index.tileCoords) {
        const tile = index.getTile(z, x, y);
        if (tile && tile.features.some(f => f.id === id)) found.push({z, x, y});
    }
    return found.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
}

test('getFeature: cross-tile polygon reports every containing tile, matching a full tile scan', () => {
    const polygon = {
        type: 'Feature',
        id: 'poly-1',
        properties: {name: 'big square'},
        geometry: {
            type: 'Polygon',
            coordinates: [[[-100, 60], [100, 60], [100, -60], [-100, -60], [-100, 60]]]
        }
    };
    const index = new GeoJSONVT(polygon, {indexMaxZoom: 3, indexMaxPoints: 0, buffer: 0});

    const info = index.getFeature('poly-1');
    assert.ok(info, 'indexed feature should be found');
    assert.equal(info.id, 'poly-1');
    assert.equal(info.type, 'Polygon');
    assert.deepEqual(info.tags, {name: 'big square'});
    assert.deepEqual(info.bbox, [-100, -60, 100, 60]); // original GeoJSON lng/lat, [minX,minY,maxX,maxY]
    assert.ok(info.tiles.length > 4, 'a world-spanning polygon should land in many tiles');

    // independent ground truth: scan every generated tile
    assert.deepEqual(info.tiles, scanTiles(index, 'poly-1'));

    // z/x/y ascending
    for (let i = 1; i < info.tiles.length; i++) {
        const a = info.tiles[i - 1], b = info.tiles[i];
        const key = t => t.z * 1e10 + t.x * 1e5 + t.y;
        assert.ok(key(a) < key(b), `tiles not ascending at ${i}`);
    }

    // the id exposed by getFeature is exactly the id on tile features
    for (const {z, x, y} of info.tiles) {
        assert.ok(index.getTile(z, x, y).features.some(f => f.id === 'poly-1'));
    }
});

test('getFeature: Point and LineString types and point bbox', () => {
    const data = {
        type: 'FeatureCollection',
        features: [
            pointFeature(11, [10, 20], {kind: 'pt'}),
            {
                type: 'Feature',
                id: 'line-1',
                properties: {kind: 'ln'},
                geometry: {type: 'LineString', coordinates: [[-50, -10], [50, 10]]}
            }
        ]
    };
    const index = new GeoJSONVT(data, {indexMaxZoom: 2, indexMaxPoints: 0});

    const pt = index.getFeature(11);
    assert.equal(pt.type, 'Point');
    assert.deepEqual(pt.bbox, [10, 20, 10, 20]); // degenerate point bbox
    assert.deepEqual(pt.tiles, scanTiles(index, 11));

    const line = index.getFeature('line-1');
    assert.equal(line.type, 'LineString');
    assert.deepEqual(line.bbox, [-50, -10, 50, 10]);
    assert.deepEqual(line.tiles, scanTiles(index, 'line-1'));
});

test('getFeature: returns null for an id no source feature carries', () => {
    const index = new GeoJSONVT(pointFeature(1, [0, 0]));
    assert.equal(index.getFeature(999), null);
    assert.equal(index.getFeature('1'), null); // number 1 exists, string '1' does not
});

test('getFeatureIds: stable ascending order, numbers before strings, types never conflated', () => {
    const data = {
        type: 'FeatureCollection',
        features: [
            pointFeature('b', [1, 1]),
            pointFeature(10, [2, 2]),
            pointFeature(2, [3, 3]),
            pointFeature('a', [4, 4]),
            pointFeature('10', [5, 5]), // distinct from numeric 10
            pointFeature(1, [6, 6])
        ]
    };
    const index = new GeoJSONVT(data);

    const expected = [1, 2, 10, '10', 'a', 'b'];
    assert.deepEqual(index.getFeatureIds(), expected);
    // stable across repeated calls and after getTile drill-downs
    index.getTile(3, 4, 4);
    assert.deepEqual(index.getFeatureIds(), expected);
    assert.deepEqual(index.getFeatureIds(), expected);

    // numeric 10 and string '10' are separate entries
    assert.notEqual(index.getFeature(10), null);
    assert.notEqual(index.getFeature('10'), null);

    // the returned array is a copy: mutating it cannot corrupt the index
    const ids = index.getFeatureIds();
    ids.push('tampered');
    assert.deepEqual(index.getFeatureIds(), expected);
});

test('promoteId: string and number property values are indexed with their native type', () => {
    const data = {
        type: 'FeatureCollection',
        features: [
            {type: 'Feature', properties: {uid: 'alpha'}, geometry: {type: 'Point', coordinates: [0, 0]}},
            {type: 'Feature', properties: {uid: 42}, geometry: {type: 'Point', coordinates: [10, 10]}},
            {type: 'Feature', properties: {uid: 7}, geometry: {type: 'Point', coordinates: [20, 20]}}
        ]
    };
    const index = new GeoJSONVT(data, {promoteId: 'uid', indexMaxZoom: 1, indexMaxPoints: 0});

    assert.deepEqual(index.getFeatureIds(), [7, 42, 'alpha']); // numeric ascending (7 < 42), strings last

    const str = index.getFeature('alpha');
    assert.equal(str.type, 'Point');
    assert.deepEqual(str.tiles, scanTiles(index, 'alpha'));

    const num = index.getFeature(42);
    assert.deepEqual(num.bbox, [10, 10, 10, 10]);
    assert.deepEqual(num.tiles, scanTiles(index, 42));

    // ids on tile features are exactly the promoted values (compared as a set — default .sort() is
    // lexicographic and would misorder the numeric ids)
    const tileIds = index.getTile(0, 0, 0).features.map(f => f.id);
    assert.equal(tileIds.length, 3);
    for (const id of ['alpha', 42, 7]) assert.ok(tileIds.includes(id), `tile missing id ${id}`);
});

test('generateId: globally unique sequential ids, stable across drill-down', () => {
    const data = {
        type: 'FeatureCollection',
        features: Array.from({length: 25}, (_, i) => pointFeature(-1, [i * 12 - 150, ((i * 37) % 80) - 40]))
    };
    const index = new GeoJSONVT(data, {generateId: true, indexMaxZoom: 0});

    // ids are assigned once at convert time — 0..N-1 — never recounted per tile
    assert.deepEqual(index.getFeatureIds(), Array.from({length: 25}, (_, i) => i));

    // drill into a tile not built during construction; every id it carries resolves in the index
    const tile = index.getTile(4, 8, 7);
    assert.ok(tile, 'expected drill-down to build the tile');
    for (const f of tile.features) {
        assert.equal(typeof f.id, 'number');
        assert.ok(index.getFeature(f.id) !== null, `generated id ${f.id} missing from index`);
    }
});

test('duplicate ids throw "duplicate feature id" for native ids and promoteId', () => {
    const dup = features => new GeoJSONVT({type: 'FeatureCollection', features});

    assert.throws(
        () => dup([pointFeature(5, [0, 0]), pointFeature(5, [1, 1])]),
        {message: 'duplicate feature id'});

    assert.throws(
        () => dup([pointFeature('x', [0, 0]), pointFeature('x', [1, 1])]),
        {message: 'duplicate feature id'});

    // promoteId collisions surface the same guard
    assert.throws(() => new GeoJSONVT({
        type: 'FeatureCollection',
        features: [
            {type: 'Feature', properties: {k: 1}, geometry: {type: 'Point', coordinates: [0, 0]}},
            {type: 'Feature', properties: {k: 1}, geometry: {type: 'Point', coordinates: [1, 1]}}
        ]
    }, {promoteId: 'k'}), {message: 'duplicate feature id'});
});

test('one source feature emitting several internal features is indexed once (no false duplicate)', () => {
    // GeometryCollection recursion and lineMetrics MultiLineString explosion both fan one source
    // feature out into multiple internal features sharing its id.
    const collection = new GeoJSONVT({
        type: 'Feature',
        id: 'gc-1',
        properties: {n: 1},
        geometry: {
            type: 'GeometryCollection',
            geometries: [
                {type: 'Point', coordinates: [10, 10]},
                {type: 'LineString', coordinates: [[0, 0], [20, 20]]}
            ]
        }
    });
    assert.deepEqual(collection.getFeatureIds(), ['gc-1']);
    const info = collection.getFeature('gc-1');
    assert.deepEqual(info.bbox, [0, 0, 20, 20]); // bbox spans both sub-geometries
    assert.ok(info.tiles.length > 0);

    const mls = new GeoJSONVT({
        type: 'Feature',
        id: 'mls-1',
        properties: {},
        geometry: {
            type: 'MultiLineString',
            coordinates: [[[0, 0], [10, 10]], [[20, 20], [30, 30]]]
        }
    }, {lineMetrics: true});
    assert.deepEqual(mls.getFeatureIds(), ['mls-1']);
    assert.equal(mls.getFeature('mls-1').type, 'LineString');
});

test('drill-down: newly generated tiles are added, repeated lookups do not grow the index', () => {
    const polygon = {
        type: 'Feature',
        id: 'p',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[[-120, 70], [120, 70], [120, -70], [-120, -70], [-120, 70]]]
        }
    };
    // shallow construction: only z0 is built, so a z5 request forces splitTile drill-down
    const index = new GeoJSONVT(polygon, {indexMaxZoom: 0, buffer: 0});
    const initial = index.getFeature('p').tiles;
    assert.deepEqual(initial, [{z: 0, x: 0, y: 0}]);

    const drilled = index.getTile(5, 10, 12);
    assert.ok(drilled, 'drill-down should build the requested tile');

    const afterDrill = index.getFeature('p');
    assert.ok(afterDrill.tiles.some(t => t.z === 5 && t.x === 10 && t.y === 12),
        'the drilled tile must be recorded');
    assert.deepEqual(afterDrill.tiles, scanTiles(index, 'p'));
    const countAfterDrill = afterDrill.tiles.length;

    // repeat getTile / getFeature: the same tile is not double-counted, output stays identical
    index.getTile(5, 10, 12);
    index.getTileRaw(5, 10, 12);
    const repeated = index.getFeature('p');
    assert.equal(repeated.tiles.length, countAfterDrill);
    assert.deepEqual(repeated, afterDrill);
    assert.deepEqual(repeated.tiles, scanTiles(index, 'p'));

    // a second, disjoint drill extends the index further without disturbing earlier entries
    index.getTile(5, 20, 11);
    const second = index.getFeature('p');
    assert.ok(second.tiles.length > countAfterDrill);
    assert.ok(second.tiles.some(t => t.z === 5 && t.x === 20 && t.y === 11));
    assert.deepEqual(second.tiles, scanTiles(index, 'p'));
});

test('anonymous features: no ids means an empty index and no errors', () => {
    const index = new GeoJSONVT({
        type: 'FeatureCollection',
        features: [
            {type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [0, 0]}},
            {type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [1, 1]}}
        ]
    });
    assert.deepEqual(index.getFeatureIds(), []);
    assert.equal(index.getFeature(0), null);
    // tiling itself is unaffected
    assert.ok(index.getTile(0, 0, 0).features.length === 2);
});

test('getFeature result is a fresh copy each call', () => {
    const index = new GeoJSONVT(pointFeature(1, [0, 0], {k: 'v'}));
    const a = index.getFeature(1);
    const b = index.getFeature(1);
    assert.notEqual(a, b);
    assert.notEqual(a.tiles, b.tiles);
    assert.notEqual(a.bbox, b.bbox);
    assert.deepEqual(a, b);
    a.tiles.push({z: 9, x: 9, y: 9});
    a.bbox.push(999);
    assert.equal(index.getFeature(1).tiles.length, b.tiles.length);
});

// Deterministic PRNG so the perf dataset is identical on every run.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

test('performance: 10k features / 100k points index stays within budget and getTile is untouched', () => {
    // The requirement is that the index must not double build/getTile cost. This is a regression guard,
    // not a hard micro-benchmark: it pins the structural properties (one entry per feature, linear
    // bookkeeping, no per-getTile index growth) that keep the cost bounded, without flaky wall-clock
    // assertions that fail on slow CI machines.
    const rand = mulberry32(42);
    const features = Array.from({length: 10000}, (_, i) => ({
        type: 'Feature',
        id: i,
        properties: {i},
        geometry: {
            type: 'MultiPoint',
            coordinates: Array.from({length: 10}, () => [rand() * 340 - 170, rand() * 160 - 80])
        }
    }));
    const data = {type: 'FeatureCollection', features};

    const index = new GeoJSONVT(data, {indexMaxZoom: 6, indexMaxPoints: 0});
    assert.equal(index.getFeatureIds().length, 10000, 'all 10k features indexed');

    // Spot-check a sample against an independent full-tile scan: index bookkeeping is O(total
    // feature-tile memberships), never a full tile sweep per lookup. Scanning every id would be O(n²)
    // materializations and is what the index exists to avoid.
    const sampleIds = [0, 137, 2048, 7777, 9999];
    for (const id of sampleIds) {
        assert.deepEqual(index.getFeature(id).tiles, scanTiles(index, id), `id ${id} tile mismatch`);
    }

    // Repeated getTile calls must not mutate the index: tile counts are stable across many reads.
    const before = index.getFeature(0).tiles.length;
    for (let rep = 0; rep < 20; rep++) {
        for (const {z, x, y} of index.tileCoords) index.getTile(z, x, y);
    }
    assert.equal(index.getFeature(0).tiles.length, before, 'getTile reads must not grow the index');

    // The returned tile array holds no duplicate coords.
    const repeated = index.getFeature(0);
    const unique = new Set(repeated.tiles.map(t => `${t.z}/${t.x}/${t.y}`));
    assert.equal(unique.size, repeated.tiles.length, 'tiles must be unique');
});
