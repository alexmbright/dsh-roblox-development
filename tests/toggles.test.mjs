import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRoutes } from '../routing.js';

const routes = loadRoutes();






test('every shipped route carries a default purpose', () => {
  const blank = [];
  for (const [role, tiers] of Object.entries(routes.roles)) {
    for (const [tier, entries] of Object.entries(tiers)) {
      const purpose = entries[0]?.purpose;
      if (typeof purpose !== 'string' || purpose.trim() === '') blank.push(`${role}/${tier}`);
    }
  }
  assert.deepEqual(blank, []);
});





test('the lead briefing lists enabled cells with their model and purpose', async () => {
  const { routesBriefing } = await import('../routing.js');
  const text = routesBriefing([
    { role: 'planner', tiers: [
      { id: 'planner/fast', provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'low', purpose: 'Plans work.', enabled: true },
      { id: 'planner/expert', provider: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high', purpose: 'Hard plans.', enabled: false },
    ] },
  ]);
  assert.match(text, /planner\/fast → deepseek-account\/deepseek-flash at low: Plans work\./);
  assert.doesNotMatch(text, /claude-opus-5-5/);
  assert.match(text, /roblox_routes/);
});

test('the briefing is undefined when nothing is enabled', async () => {
  const { routesBriefing } = await import('../routing.js');
  assert.equal(routesBriefing([{ role: 'qa', tiers: [{ id: 'qa/fast', enabled: false }] }]), undefined);
  assert.equal(routesBriefing([]), undefined);
});
