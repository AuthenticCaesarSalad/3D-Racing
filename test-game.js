'use strict';

const assert = require('node:assert/strict');
const { clamp, laneX, charge, scoreFor, makeRow, sweptHit, sceneryAt, blendBoost } = require('./game.js');
let seed = 429;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const safeLanes = new Set();
for (let i = 0; i < 10000; i++) {
  const row = makeRow(110 + i * 54, random);
  assert.ok(row.barriers.length >= 1 && row.barriers.length <= 2);
  assert.equal(new Set(row.barriers).size, row.barriers.length);
  assert.ok(row.barriers.every(lane => Number.isInteger(lane) && lane >= 0 && lane <= 2));
  assert.equal(row.shards.length, 3);
  for (const shard of row.shards) {
    assert.ok(!row.barriers.includes(shard.lane), 'Each row must have a collectible path with no barrier');
    assert.ok(shard.offset > 0 && shard.offset < 54);
    assert.equal(shard.collected, false);
    safeLanes.add(shard.lane);
  }
}
assert.equal(safeLanes.size, 3);
assert.equal(clamp(-1, 0, 2), 0);
assert.equal(clamp(3, 0, 2), 2);
assert.deepEqual([-1, 0, 1, 2, 3].map(laneX), [-3.2, -3.2, 0, 3.2, 3.2]);
assert.equal(sweptHit(0, 0, 60, -60, 0, 1.6, 1.75), true, 'Large frames cannot tunnel through barriers');
assert.equal(sweptHit(-3.2, -3.2, 60, -60, 0, 1.6, 1.75), false, 'An adjacent open lane is safe');
assert.equal(sweptHit(-3.2, 3.2, 3, -3, 0, 1.6, 1.75), true, 'Diagonal crossings hit');
assert.equal(sweptHit(-3.2, 0, 1, -12, 0, 1.6, 1.75), false, 'Different-axis overlaps at different times do not hit');
assert.equal(sweptHit(0, 0, 5, 3, 0, 1.6, 1.75), false);
assert.equal(sweptHit(0, 0, -3, -5, 0, 1.6, 1.75), false);
assert.equal(sweptHit(0, 0, 0, 0, 0, 0.93, 1.5), true);
assert.equal(sweptHit(0, 0, 40, -40, 0, 0.93, 1.5), true, 'Shard collection also uses swept bounds');
assert.equal(charge(0.1, 20, true), 0);
assert.equal(charge(0.9, 20, false), 1);
assert.ok(charge(0.5, 0.1, true) < 0.5);
assert.ok(charge(0.5, 0.1, false) > 0.5);
assert.equal(scoreFor(100, 2), 295);
assert.equal(scoreFor(0, 0), 0);
assert.equal(scoreFor(1e9, 1e9), 999999);
assert.equal(scoreFor(-100, 0), 0);

for (const side of [-1, 1, 0]) {
  const spacing = side === 0 ? 7.5 : 34;
  const count = side === 0 ? 46 : 11;
  for (const cycle of [1, 2, 3, 4, 11, 132, 1000000]) {
    const boundary = cycle * spacing;
    // Include exact wraps, ordinary motion, and jumps crossing several recycling boundaries.
    for (const [before, after] of [[boundary - 0.01, boundary], [boundary - 0.01, boundary + 0.01], [boundary, boundary + 0.25], [boundary - 0.01, boundary + spacing * 3 + 0.25]]) {
      const previous = new Map(Array.from({ length: count }, (_, slot) => {
        const item = sceneryAt(before, slot, side);
        return [item.id, item];
      }));
      let survivors = 0;
      for (let slot = 0; slot < count; slot++) {
        const { z, ...appearance } = sceneryAt(after, slot, side);
        const old = previous.get(appearance.id);
        if (!old) continue;
        const { z: oldZ, ...oldAppearance } = old;
        assert.deepEqual(appearance, oldAppearance, `World ${appearance.id}, side ${side}: appearance must survive recycling`);
        assert.ok(z > oldZ, 'Surviving scenery must keep moving toward the camera');
        assert.ok(Math.abs((z - oldZ) - (after - before)) < 1e-7, 'Scenery must advance by exactly the traveled distance');
        survivors++;
      }
      assert.equal(survivors, count - (Math.floor(after / spacing) - Math.floor(before / spacing)));
    }
  }
}
assert.equal(sceneryAt(0, 0).isLime, true);
assert.equal(sceneryAt(0, 1).isLime, false);
assert.deepEqual(sceneryAt(0, 0, -1), { id: 0, z: 18, h: 5, x: -10, width: 2.3, roofWidth: 2.65, isCyan: false });
assert.deepEqual(sceneryAt(0, 1, 1), { id: 1, z: -16, h: 7, x: 14.3, width: 3.3, roofWidth: 3.65, isCyan: true });

const boostTraces = [30, 60, 120].map(hz => {
  let value = 0;
  const trace = [];
  for (const [held, duration] of [[true, 0.5], [false, 0.5], [true, 1], [false, 1]]) {
    for (let frame = 0; frame < hz * duration; frame++) {
      const previous = value;
      value = blendBoost(value, 1 / hz, held);
      assert.ok(value >= 0 && value <= 1, 'Boost blend must stay bounded');
      assert.ok(held ? value > previous && value < 1 : value < previous && value > 0, 'Press and release must converge monotonically without snapping');
    }
    assert.ok(held ? value > 0.98 : value < 0.02, 'Boost blend must converge toward the held state');
    trace.push(value);
  }
  return trace;
});
for (const trace of boostTraces) {
  trace.forEach((value, phase) => assert.ok(Math.abs(value - boostTraces[0][phase]) < 1e-12, 'Boost response must agree at 30/60/120 Hz'));
}
assert.equal(blendBoost(0, 1, false), 0);
assert.equal(blendBoost(1, 1, true), 1);
assert.equal(blendBoost(0.4, 0, true), 0.4);
assert.equal(blendBoost(0.4, 0, false), 0.4);
assert.equal(blendBoost(0, 100, true), 1);
assert.equal(blendBoost(1, 100, false), 0);
console.log('NEON DRIFT checks passed: 10,000 safe rows, lane limits, swept collisions, boost/score bounds, stable scenery recycling, and smooth boost at 30/60/120 Hz.');
