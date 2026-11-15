/**
 * Routing panel for the Roblox development bundle.
 *
 * One section per role, and under it one row per tier with its model picker, its switch and
 * its purpose. The model list is the set of providers and models this installation actually
 * has connected, so the panel can only offer models that can really be dispatched.
 */
window.__ModuleLoader__.load({
  id: '@alexturbo/dsh-roblox-development',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const ENDPOINT = 'api/roblox-controls';

    /** Resolve one bridge endpoint against the page origin. */
    function endpointUrl(path) {
      try {
        return new URL(`${ENDPOINT}/${path}`, document.baseURI).toString();
      } catch {
        return `${ENDPOINT}/${path}`;
      }
    }

    /** POST one bridge endpoint and normalize failures into an Error carrying the code. */
    async function post(path, body) {
      const response = await fetch(endpointUrl(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        const error = new Error(data.message ?? `request failed with HTTP ${response.status}`);
        error.code = data.code;
        throw error;
      }
      return data;
    }

    const box = { display: 'flex', flexDirection: 'column', gap: '10px', margin: '8px 0 4px', fontSize: '13px', color: 'inherit' };
    const roleHead = { fontWeight: 600, marginTop: '12px', fontSize: '13px', textTransform: 'capitalize' };
    const muted = { opacity: 0.65, fontSize: '12px' };
    const row = { display: 'grid', gridTemplateColumns: '20px 90px minmax(160px, 280px)', gap: '8px', alignItems: 'center' };
    const tierBlock = { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' };
    const control = {
      font: 'inherit', fontSize: '12px', padding: '3px 6px', borderRadius: '6px',
      border: '1px solid rgba(128,128,128,0.45)', background: 'transparent', color: 'inherit',
      minWidth: 0, width: '100%',
    };
    const button = {
      font: 'inherit', fontSize: '12px', padding: '4px 12px', borderRadius: '6px',
      border: '1px solid rgba(128,128,128,0.5)', background: 'transparent', color: 'inherit', cursor: 'pointer',
    };
    const notice = tone => ({ fontSize: '12px', color: tone === 'error' ? '#d64545' : '#2f8f4e' });

    function RoutingPanel() {
      const [status, setStatus] = useState('loading');
      const [failure, setFailure] = useState(null);
      const [data, setData] = useState({ roles: [], models: [] });
      const [disabledCells, setDisabledCells] = useState([]);
      const [overrides, setOverrides] = useState({});
      const [descriptions, setDescriptions] = useState({});
      const [saving, setSaving] = useState(false);
      const [saved, setSaved] = useState(null);

      const load = useCallback(async () => {
        setStatus('loading');
        setFailure(null);
        try {
          const payload = await post('read');
          setData({ roles: payload.roles ?? [], models: payload.models ?? [] });
          setDisabledCells(payload.config?.disabledCells ?? []);
          setOverrides(payload.config?.overrides ?? {});
          setDescriptions(payload.config?.descriptions ?? {});
          setStatus('ready');
        } catch (error) {
          setFailure(error);
          setStatus('failed');
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const toggleCell = id => {
        setSaved(null);
        setDisabledCells(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]));
      };

      const chooseModel = (tier, value) => {
        setSaved(null);
        const [provider, model] = value.split('/');
        const entry = (data.models ?? []).find(candidate => candidate.provider === provider && candidate.model === model);
        const efforts = entry?.efforts ?? [];
        const effort = efforts.includes(tier.reasoning_effort) ? tier.reasoning_effort : (efforts.at(-1) ?? tier.reasoning_effort);
        setOverrides(current => ({ ...current, [tier.id]: { provider, model, reasoning_effort: effort } }));
      };

      const save = async () => {
        setSaving(true);
        setFailure(null);
        setSaved(null);
        try {
          const kept = Object.fromEntries(Object.entries(descriptions).filter(([, text]) => typeof text === 'string' && text.trim() !== ''));
          await post('write', { disabledCells, overrides, descriptions: kept });
          // Reload so the pickers, source labels and catalog reflect what was saved.
          await load();
          setSaved('Saved. The guard applies this immediately.');
        } catch (error) {
          setFailure(error);
        } finally {
          setSaving(false);
        }
      };

      if (status === 'loading') return h('div', { style: muted }, 'Loading routing…');
      if (status === 'failed') {
        return h('div', { style: box },
          h('div', { style: notice('error'), role: 'alert' }, `Routing unavailable: ${failure?.message ?? 'unknown error'}`),
          h('button', { type: 'button', style: button, onClick: load }, 'Retry'));
      }

      const modelOptions = (data.models ?? []).map(entry => ({
        value: `${entry.provider}/${entry.model}`,
        label: entry.label ?? `${entry.provider}/${entry.model}`,
      }));

      // Final review needs a different provider from the implementer; with a single seeded
      // model that cannot hold, so say so instead of letting the preset promise independence.
      const implementerProviders = new Set(data.roles.filter(role => role.role === 'implementer')
        .flatMap(role => role.tiers.map(tier => overrides[tier.id]?.provider ?? tier.provider)));
      const reviewerShares = data.roles.filter(role => role.role === 'reviewer')
        .flatMap(role => role.tiers)
        .filter(tier => implementerProviders.has(overrides[tier.id]?.provider ?? tier.provider)).length;

      return h('div', { style: box, 'data-roblox-routing': true },
        h('div', { style: muted }, `${data.roles.reduce((total, role) => total + role.tiers.length, 0)} role/tier cells · `
          + `${(data.models ?? []).length} connected models`),
        reviewerShares === 0 ? null : h('div', { style: { ...muted, color: '#c98a2b' }, role: 'status' },
          `${reviewerShares} reviewer cell${reviewerShares === 1 ? '' : 's'} use the same provider as the implementer, so final review cannot be independent.`),

        ...data.roles.map(role => h('div', { key: role.role },
          h('div', { style: roleHead }, role.role),
          ...role.tiers.map(tier => {
            const currentModel = overrides[tier.id] ?? { provider: tier.provider, model: tier.model };
            const value = `${currentModel.provider}/${currentModel.model}`;
            const options = modelOptions.some(option => option.value === value)
              ? modelOptions
              : [...modelOptions, { value, label: `${value} (not connected)` }];
            return h('div', { key: tier.id, style: tierBlock },
              h('div', { style: row },
                h('input', {
                  type: 'checkbox',
                  'aria-label': `${tier.id} enabled`,
                  checked: !disabledCells.includes(tier.id),
                  onChange: () => toggleCell(tier.id),
                }),
                h('span', { style: muted }, tier.tier),
                h('select', {
                  'aria-label': `${tier.id} model`,
                  value,
                  disabled: disabledCells.includes(tier.id),
                  onChange: event => chooseModel(tier, event.target.value),
                  style: control,
                }, options.map(option => h('option', { key: option.value, value: option.value }, option.label)))),
              h('textarea', {
                'aria-label': `${tier.id} purpose`,
                placeholder: 'What this tier is for — the lead reads this',
                rows: 2,
                value: descriptions[tier.id] ?? tier.purpose ?? '',
                disabled: disabledCells.includes(tier.id),
                onChange: event => { setSaved(null); setDescriptions({ ...descriptions, [tier.id]: event.target.value }); },
                style: { ...control, marginLeft: '28px', width: 'calc(100% - 28px)', minHeight: '44px', resize: 'vertical', lineHeight: 1.4 },
              }));
          }))),

        failure === null ? null : h('div', { style: notice('error'), role: 'alert' }, failure.message),
        saved === null ? null : h('div', { style: notice('ok'), role: 'status' }, saved),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
          h('button', { type: 'button', style: button, disabled: saving, onClick: save }, saving ? 'Saving…' : 'Save routing'),
          h('button', {
            type: 'button',
            style: button,
            disabled: saving || Object.keys(descriptions).length === 0,
            onClick: () => { setSaved(null); setDescriptions({}); },
          }, 'Revert descriptions'),
          h('button', { type: 'button', style: button, disabled: saving, onClick: load }, 'Reload')));
    }

    /** Full settings page for this bundle. */
    function RoutingSection() {
      return h('section', { 'data-roblox-routing-section': true },
        h('h3', { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600 } }, 'Roblox routing'),
        h('p', { style: { ...muted, margin: '0 0 8px' } },
          'Pick the model each role/tier dispatches, switch off the tiers this profile should not use, '
          + 'and describe what each tier is for. These choices are the only source of the routing matrix: '
          + 'a fresh install seeds them from your default model, and nothing is inherited from routes.json. '
          + 'A newly chosen model becomes dispatchable for new sessions after DSH restarts.'),
        h(RoutingPanel));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'roblox-routing',
          order: 25,
          label: 'Roblox routing',
        }, RoutingSection));
      },
    };
  },
});
