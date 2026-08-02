'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSampleDeduper } = require('../server/services/sample-deduper');

test('WiiM history sample deduper accepts new samples and rejects repeated responses', () => {
    const deduper = createSampleDeduper({ maxEntries: 4 });
    const first = { sampleId: 'wiim:1', fetchedAt: 1_000 };
    assert.equal(deduper.has(first), false);
    assert.equal(deduper.add(first), true);
    assert.equal(deduper.add({ sampleId: 'wiim:1', fetchedAt: 1_000 }), false);
    assert.equal(deduper.has({ sampleId: 'wiim:1', fetchedAt: 1_000 }), true);
    assert.equal(deduper.add({ sampleId: 'wiim:2', fetchedAt: 2_000 }), true);
    assert.equal(deduper.add({ fetchedAt: 3_000 }), true);
    assert.equal(deduper.size(), 3);
});
