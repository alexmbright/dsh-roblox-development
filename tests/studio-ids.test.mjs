import test from 'node:test';
import assert from 'node:assert/strict';
import { crossNamespaceDenial, idsInListing } from '../studio-ids.js';

let seq = 0;
const listed = (tool, text) => {
  const callId = `l${seq += 1}`;
  return [
    { type: 'tool/call', data: { name: tool, callId, arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } } },
  ];
};
const session = events => ({ id: 's', header: {}, events });
const call = (s, name, args) => ({ name, arguments: args, agent: { id: 's', session: s } });

const official = listed('mcp__Roblox_Studio__list_roblox_studios', JSON.stringify({ studios: [{ studio_id: 'studio-AAA1', name: 'Place' }] }));
const chrrxs = listed('mcp__robloxstudio__get_connected_instances', JSON.stringify({ instances: [{ id: 'inst-BBB2', placeName: 'Place', peers: {} }] }));

test('ids are read from either server\'s listing', () => {
  assert.ok(idsInListing(JSON.stringify({ studios: [{ studio_id: 'studio-AAA1' }] })).has('studio-AAA1'));
  assert.ok(idsInListing(JSON.stringify({ instances: [{ id: 'inst-BBB2' }] })).has('inst-BBB2'));
});

test('an official studio_id passed to a chrrxs tool is refused, and the reverse', () => {
  const s = session([...official, ...chrrxs]);
  const wrong = crossNamespaceDenial(call(s, 'mcp__robloxstudio__execute_luau', { instance_id: 'studio-AAA1', code: 'print(1)' }));
  assert.equal(wrong.info.code, 'STUDIO_ID_NAMESPACE');
  assert.match(wrong.reason, /came from list_roblox_studios .*needs a instance_id from get_connected_instances/);
  assert.equal(crossNamespaceDenial(call(s, 'mcp__Roblox_Studio__execute_luau', { studio_id: 'inst-BBB2' }))?.info.code, 'STUDIO_ID_NAMESPACE');
  assert.equal(crossNamespaceDenial(call(s, 'mcp__robloxstudio__execute_luau', { instance_id: 'inst-BBB2' })), undefined);
  assert.equal(crossNamespaceDenial(call(s, 'mcp__Roblox_Studio__execute_luau', { studio_id: 'studio-AAA1' })), undefined);
});

test('the wrong argument name for a server is refused', () => {
  const denial = crossNamespaceDenial(call(session([]), 'mcp__robloxstudio__capture_screenshot', { studio_id: 'x-1234' }));
  assert.match(denial.reason, /takes instance_id, not studio_id/);
});

test('unlisted ids and non-Studio tools are left alone', () => {
  assert.equal(crossNamespaceDenial(call(session([]), 'mcp__robloxstudio__execute_luau', { instance_id: 'never-listed' })), undefined);
  assert.equal(crossNamespaceDenial(call(session([...official]), 'read', { studio_id: 'studio-AAA1' })), undefined);
});
