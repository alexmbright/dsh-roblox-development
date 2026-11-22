/**
 * Routing panel for the Roblox development bundle.
 *
 * One section per role, and under it one row per tier with its switch, model picker, effort
 * picker and purpose. The model list is the set of providers and models this installation actually
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
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
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
    const row = { display: 'grid', gridTemplateColumns: '20px 90px minmax(160px, 280px) minmax(80px, 120px)', gap: '8px', alignItems: 'center' };
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

      /** Change only the effort, keeping the tier's current model. */
      const chooseEffort = (tier, effort) => {
        setSaved(null);
        setOverrides(current => {
          const base = current[tier.id] ?? { provider: tier.provider, model: tier.model };
          return { ...current, [tier.id]: { provider: base.provider, model: base.model, reasoning_effort: effort } };
        });
      };

      const save = async () => {
        setSaving(true);
        setFailure(null);
        setSaved(null);
        try {
          const kept = Object.fromEntries(Object.entries(descriptions).filter(([, text]) => typeof text === 'string' && text.trim() !== ''));
          const result = await post('write', { disabledCells, overrides, descriptions: kept });
          // Reload so the pickers, source labels and catalog reflect what was saved.
          await load();
          setSaved(result.applied?.applied === false
            ? `Saved and applied to the guard. New models become dispatchable after DSH restarts (${result.applied.reason}).`
            : 'Saved and applied. New models are dispatchable for new sessions now.');
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

      // Independent review needs a different worker, not a different provider, so no provider warning.
      return h('div', { style: box, 'data-roblox-routing': true },
        h('div', { style: muted }, `${data.roles.reduce((total, role) => total + role.tiers.length, 0)} role/tier cells · `
          + `${(data.models ?? []).length} connected models`),

        ...data.roles.map(role => h('div', { key: role.role },
          h('div', { style: roleHead }, role.role),
          ...role.tiers.map(tier => {
            const currentModel = overrides[tier.id] ?? { provider: tier.provider, model: tier.model };
            const value = `${currentModel.provider}/${currentModel.model}`;
            const options = modelOptions.some(option => option.value === value)
              ? modelOptions
              : [...modelOptions, { value, label: `${value} (not connected)` }];
            const unset = currentModel.provider === '' || currentModel.model === '';
            const declared = (data.models ?? [])
              .find(entry => entry.provider === currentModel.provider && entry.model === currentModel.model)?.efforts ?? [];
            const effort = overrides[tier.id]?.reasoning_effort ?? tier.reasoning_effort ?? '';
            // Offer what the model declares; keep a saved value it no longer declares visible so the
            // save error makes sense instead of the picker silently showing something else.
            const efforts = effort !== '' && !declared.includes(effort) ? [...declared, effort] : declared;
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
                }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
                h('select', {
                  'aria-label': `${tier.id} reasoning effort`,
                  title: 'Reasoning effort this tier dispatches with',
                  value: effort,
                  disabled: disabledCells.includes(tier.id) || unset || efforts.length === 0,
                  onChange: event => chooseEffort(tier, event.target.value),
                  style: control,
                }, efforts.length === 0
                  ? [h('option', { key: 'none', value: effort }, effort === '' ? 'default' : effort)]
                  : efforts.map(id => h('option', { key: id, value: id },
                    declared.includes(id) ? id : `${id} (not supported)`)))),
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
          'Pick the model and reasoning effort each role/tier dispatches, switch off the tiers this profile should not use, '
          + 'and describe what each tier is for. These choices are the only source of the routing matrix: '
          + 'a fresh install seeds them from your default model, and nothing is inherited from routes.json. '
          + 'Changes apply as soon as they are saved: a newly chosen model is dispatchable for new sessions, '
          + 'and sessions already running keep the models they started with.'),
        h(RoutingPanel));
    }

    /* ------------------------------------------------------------------------------------------ */
    /* Visual gate toggle                                                                          */
    /* ------------------------------------------------------------------------------------------ */

    const GATE_NEW_SESSION = 'New sessions use this setting. Sessions that are already running keep the setting they started with, '
      + 'so start a new Roblox development session after you change it.';

    /** Saved, persisted on/off switch for the visual gate; Off is the default. */
    function VisualGatePanel() {
      const [state, setState] = useState({ status: 'loading', value: 'off', legacy: false });
      const [failure, setFailure] = useState(null);
      const [saving, setSaving] = useState(false);
      const [saved, setSaved] = useState(null);

      const load = useCallback(async () => {
        setFailure(null);
        try {
          const payload = await post('visual-gate/read');
          setState({ status: 'ready', value: payload.value === 'on' ? 'on' : 'off', legacy: payload.legacy === true });
        } catch (error) {
          setFailure(error);
          setState(current => ({ ...current, status: 'failed' }));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const choose = async next => {
        setSaving(true);
        setFailure(null);
        setSaved(null);
        try {
          const result = await post('visual-gate/write', { value: next });
          setState({ status: 'ready', value: result.value === 'on' ? 'on' : 'off', legacy: false });
          setSaved(result.applied?.applied === false
            ? `Saved: Visual gate ${result.value === 'on' ? 'On' : 'Off'}. DSH could not reload the profile live (${result.applied.reason}), `
              + 'so restart DSH, then start a new Roblox development session.'
            : `Saved: Visual gate ${result.value === 'on' ? 'On' : 'Off'}. Start a new Roblox development session to use it; running sessions keep their previous setting.`);
        } catch (error) {
          setFailure(error);
        } finally {
          setSaving(false);
        }
      };

      if (state.status === 'loading') return h('div', { style: muted }, 'Loading Visual gate…');
      if (state.status === 'failed') {
        return h('div', { style: box },
          h('div', { style: notice('error'), role: 'alert' }, `Visual gate unavailable: ${failure?.message ?? 'unknown error'}`),
          h('button', { type: 'button', style: button, onClick: load }, 'Retry'));
      }
      const on = state.value === 'on';
      return h('div', { style: box, 'data-roblox-visual-gate': on ? 'on' : 'off' },
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontWeight: 600 } },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-label': 'Visual gate',
            checked: on,
            disabled: saving,
            onChange: () => choose(on ? 'off' : 'on'),
          }),
          h('span', null, `Visual gate: ${on ? 'On' : 'Off'}`)),
        h('div', { style: muted }, on
          ? 'On: the full gate is enforced for UI, art, scene and layout work. A visual reviewer, a screenshot checklist in VISUAL_GATE.md and a fresh review after every edit are required before visual work counts as done.'
          : 'Off (default): a routine UI task finishes with one implementer and one Studio check. There is no formal visual reviewer, screenshot checklist or reapproval after edits. Studio screenshots and playtests stay available.'),
        h('div', { style: muted }, 'Turn it On for polish or release work. Existing VISUAL_GATE.md files are kept either way.'),
        state.legacy ? h('div', { style: muted, role: 'status' }, 'A legacy “auto” value was found and is treated as Off. Choose On or Off to replace it.') : null,
        h('div', { style: { ...muted, color: '#c98a2b' }, role: 'note' }, GATE_NEW_SESSION
          + ' If DSH cannot reload the profile live, restart DSH first.'),
        failure === null ? null : h('div', { style: notice('error'), role: 'alert' }, failure.message),
        saved === null ? null : h('div', { style: notice('ok'), role: 'status' }, saved));
    }

    function VisualGateSection() {
      return h('section', { 'data-roblox-visual-gate-section': true },
        h('h3', { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600 } }, 'Roblox visual gate'),
        h('p', { style: { ...muted, margin: '0 0 8px' } },
          'Controls whether UI, art and scene work needs the formal visual review before it counts as done. '
          + 'The same setting drives the runtime guard and the instructions the lead reads.'),
        h(VisualGatePanel));
    }

    /* ------------------------------------------------------------------------------------------ */
    /* Open Cloud credentials section                                                              */
    /* ------------------------------------------------------------------------------------------ */

    const CLOUD = 'api/roblox-open-cloud';

    /** POST one Open Cloud bridge endpoint; failures become an Error carrying the server's message. */
    async function cloudPost(path, body) {
      let url = `${CLOUD}/${path}`;
      try { url = new URL(url, document.baseURI).toString(); } catch { /* keep the relative path */ }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
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

    const CLOUD_FIELDS = [
      {
        id: 'apiKey',
        label: 'Open Cloud API key',
        secret: true,
        placeholder: 'Paste the key from Creator Hub',
        help: 'Create it at create.roblox.com → Credentials. Scopes by feature: asset:read / asset:write (asset upload and details), '
          + 'developer-product:read / write and game-pass:read / write (monetization), universe:write and place scopes (experience and place versions). '
          + 'Grant only what you use and bind the key to the experiences you work on.',
      },
      {
        id: 'creatorUserId',
        label: 'Creator user ID',
        secret: false,
        placeholder: 'Optional, numeric',
        help: 'Where uploaded assets are owned when they belong to you. Use this or the group ID.',
      },
      {
        id: 'creatorGroupId',
        label: 'Creator group ID',
        secret: false,
        placeholder: 'Optional, numeric',
        help: 'Where uploaded assets are owned when they belong to a group. Use this or the user ID.',
      },
    ];

    const SOURCE_LABELS = { stored: 'saved in DSH', file: 'saved in DSH', env: 'launch environment', project: 'project .env', home: 'home .env' };

    /** One credential field: status, a write-only input, Save and Clear. */
    function CloudField({ field, info, busy, onSave, onClear }) {
      const [draft, setDraft] = useState('');
      const configured = info?.configured === true;
      const writable = info?.writable !== false;
      const source = info?.source === undefined ? '' : (SOURCE_LABELS[info.source] ?? String(info.source));
      return h('div', { style: tierBlock, 'data-roblox-open-cloud-field': field.id },
        h('div', { style: { fontWeight: 600, fontSize: '13px' } }, field.label),
        h('div', { style: { ...muted, display: 'flex', gap: '8px', flexWrap: 'wrap' }, role: 'status' },
          h('span', null, configured ? `Set${source === '' ? '' : ` (${source})`}` : 'Not set')),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', {
            // A secret field is a password input that refuses autofill and never echoes a saved value.
            type: field.secret ? 'password' : 'text',
            inputMode: field.secret ? undefined : 'numeric',
            autoComplete: field.secret ? 'new-password' : 'off',
            spellCheck: false,
            'aria-label': field.label,
            placeholder: configured ? 'Enter a new value to replace it' : field.placeholder,
            value: draft,
            disabled: busy || !writable,
            onChange: event => setDraft(event.target.value),
            style: { ...control, maxWidth: '360px' },
          }),
          h('button', {
            type: 'button', style: button, disabled: busy || !writable || draft.trim() === '',
            onClick: async () => { if (await onSave(field.id, draft)) setDraft(''); },
          }, 'Save'),
          h('button', {
            type: 'button', style: button, disabled: busy || !writable || !configured,
            onClick: () => onClear(field.id),
          }, 'Clear')),
        h('div', { style: muted }, field.help));
    }

    function CloudPanel() {
      const [state, setState] = useState({ status: 'loading', fields: {} });
      const [failure, setFailure] = useState(null);
      const [notice_, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);

      const apply_ = payload => setState({ status: 'ready', fields: payload.fields ?? {} });

      const load = useCallback(async () => {
        setFailure(null);
        try {
          apply_(await cloudPost('read'));
        } catch (error) {
          setFailure(error);
          setState(current => ({ ...current, status: 'failed' }));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const run = async (path, body, done) => {
        setBusy(true);
        setFailure(null);
        setNotice(null);
        try {
          const payload = await cloudPost(path, body);
          apply_(payload);
          setNotice(`${done} An active robloxstudio connection refreshes automatically. This may take a moment.`);
          return true;
        } catch (error) {
          setFailure(error);
          return false;
        } finally {
          setBusy(false);
        }
      };
      const save = (id, value) => run('write', { field: id, value }, 'Saved to DSH’s credential store.');
      const clear = id => run('clear', { field: id }, 'Cleared.');

      if (state.status === 'loading') return h('div', { style: muted }, 'Loading…');
      if (state.status === 'failed') {
        return h('div', { style: box },
          h('div', { style: notice('error'), role: 'alert' }, `Open Cloud settings unavailable: ${failure?.message ?? 'unknown error'}`),
          h('button', { type: 'button', style: button, onClick: load }, 'Retry'));
      }
      return h('div', { style: box, 'data-roblox-open-cloud': true },
        ...CLOUD_FIELDS.map(field => h(CloudField, {
          key: field.id, field, info: state.fields[field.id], busy, onSave: save, onClear: clear,
        })),
        failure === null ? null : h('div', { style: notice('error'), role: 'alert' }, failure.message),
        notice_ === null ? null : h('div', { style: notice('ok'), role: 'status' }, notice_));
    }

    /** Settings page section for the Open Cloud credentials. */
    function OpenCloudSection() {
      return h('section', { 'data-roblox-open-cloud-section': true },
        h('h3', { style: { margin: '0 0 4px', fontSize: '15px', fontWeight: 600 } }, 'Roblox Open Cloud'),
        h('p', { style: { ...muted, margin: '0 0 8px' } },
          'Lets the robloxstudio MCP server call Roblox Open Cloud: asset upload and generation, monetization, experience and place-version tools. '
          + 'Values are saved in DSH’s credential store and used by the community MCP. The settings page does not show saved values. '
          + 'The official Roblox_Studio server does not use them. Everything else works without a key.'),
        h(CloudPanel));
    }

    /* ------------------------------------------------------------------------------------------ */
    /* Screenshots tab (right sidebar)                                                             */
    /* ------------------------------------------------------------------------------------------ */

    const SHOTS = 'api/roblox-screenshots';
    const TAB_ID = '@alexturbo/dsh-roblox-development/screenshots';
    const TAB_KIND = 'roblox-screenshots';
    const POLL_MS = 4000;
    const shotUrl = path => {
      try {
        return new URL(`${SHOTS}/${path}`, document.baseURI).toString();
      } catch {
        return `${SHOTS}/${path}`;
      }
    };
    const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px', padding: '10px' };
    const card = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', minWidth: 0 };
    const thumb = { width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', cursor: 'zoom-in', background: 'rgba(128,128,128,0.08)' };
    const badge = { fontSize: '10px', padding: '0 5px', borderRadius: '4px', border: '1px solid #c98a2b', color: '#c98a2b', alignSelf: 'flex-start' };
    const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

    /** Every capture in the shown Session's worker tree, refreshed while visible. */
    function ScreenshotsBody({ useTabInfo, sessionId }) {
      const { tab } = useTabInfo();
      const visible = tab?.visible !== false;
      const [state, setState] = useState({ status: 'loading', captures: [], error: null });
      const [filter, setFilter] = useState('');
      const [hideSuspicious, setHideSuspicious] = useState(false);
      const [open, setOpen] = useState(null);

      const load = useCallback(async () => {
        try {
          const response = await fetch(shotUrl('list'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
            signal: AbortSignal.timeout(20000),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok === false) throw new Error(data.message ?? `HTTP ${response.status}`);
          setState({ status: 'ready', captures: data.captures ?? [], error: null });
        } catch (error) {
          setState(current => ({ ...current, status: current.captures.length > 0 ? 'ready' : 'failed', error }));
        }
      }, [sessionId]);

      useEffect(() => {
        if (!visible) return undefined;
        load();
        const timer = setInterval(load, POLL_MS);
        return () => clearInterval(timer);
      }, [load, visible]);

      useEffect(() => {
        if (open === null) return undefined;
        const onKey = event => { if (event.key === 'Escape') setOpen(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      if (state.status === 'loading') return h('div', { style: { ...muted, padding: '12px' } }, 'Loading screenshots…');
      if (state.status === 'failed') {
        return h('div', { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          h('div', { style: notice('error'), role: 'alert' }, `Screenshots unavailable: ${state.error?.message ?? 'unknown error'}`),
          h('button', { type: 'button', style: button, onClick: load }, 'Retry'));
      }
      const agents = [...new Set(state.captures.map(capture => capture.agent))];
      const shown = state.captures.filter(capture => (filter === '' || capture.agent === filter) && !(hideSuspicious && capture.suspicious));
      const src = capture => shotUrl(`image?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(capture.id)}`);
      const when = iso => {
        try {
          return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch {
          return iso;
        }
      };
      const copy = text => { try { navigator.clipboard?.writeText(text); } catch { /* ignore */ } };

      return h('div', { style: { height: '100%', overflow: 'auto' }, 'data-roblox-screenshots': true },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '10px 10px 0', flexWrap: 'wrap' } },
          h('span', { style: muted }, `${state.captures.length} capture${state.captures.length === 1 ? '' : 's'} from the lead and its workers`),
          h('select', { 'aria-label': 'Filter by agent', value: filter, onChange: event => setFilter(event.target.value), style: { ...control, width: 'auto' } },
            h('option', { value: '' }, 'All agents'),
            ...agents.map(agent => h('option', { key: agent, value: agent }, agent))),
          h('label', { style: { ...muted, display: 'flex', gap: '4px', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: hideSuspicious, onChange: () => setHideSuspicious(!hideSuspicious) }),
            'Hide suspicious')),
        shown.length === 0
          ? h('div', { style: { ...muted, padding: '12px' } }, state.captures.length === 0
            ? 'No Studio captures yet. They appear here as soon as the lead or any worker runs screen_capture, capture_screenshot or capture_device_matrix.'
            : 'No captures match the filter.')
          : h('div', { style: grid },
            ...shown.map(capture => h('figure', { key: capture.id, style: { ...card, margin: 0 } },
              h('img', {
                src: src(capture), alt: `${capture.agent} ${capture.label || capture.tool}`, loading: 'lazy', style: thumb,
                onClick: () => setOpen(capture),
              }),
              h('figcaption', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
                h('span', { style: { ...ellipsis, fontWeight: 600 } }, `${capture.agent}${capture.label ? ` · ${capture.label}` : ''}`),
                h('span', { style: { ...ellipsis, ...muted, fontSize: '11px' } }, `${when(capture.capturedAt)} · ${capture.width}×${capture.height} · ${capture.tool}`),
                h('button', {
                  type: 'button', title: 'Copy capture id', onClick: () => copy(capture.id),
                  style: { ...button, padding: '1px 6px', fontSize: '11px', alignSelf: 'flex-start', fontFamily: 'monospace' },
                }, capture.id),
                capture.suspicious ? h('span', { style: badge, title: '256×256 or smaller, or a fallback capture: probably not the real viewport. It does not count for the visual gate.' }, 'suspicious') : null)))),
        open === null ? null : h('div', {
          role: 'dialog', 'aria-label': `Screenshot ${open.id}`,
          onClick: () => setOpen(null),
          style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', cursor: 'zoom-out', padding: '24px' },
        },
        h('img', { src: src(open), alt: open.id, style: { maxWidth: '100%', maxHeight: 'calc(100% - 40px)', objectFit: 'contain', borderRadius: '6px' } }),
        h('div', { style: { color: '#fff', fontSize: '12px' } }, `${open.id} · ${open.agent}${open.label ? ` · ${open.label}` : ''} · ${when(open.capturedAt)}`)));
    }

    function ScreenshotsTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      return tab?.title ?? 'Roblox screenshots';
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
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'roblox-visual-gate',
          order: 24,
          label: 'Roblox visual gate',
        }, VisualGateSection));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'roblox-open-cloud',
          order: 26,
          label: 'Roblox Open Cloud',
        }, OpenCloudSection));

        // The right sidebar is optional in a composition: register the tab only where it exists.
        if (typeof ctx.inject !== 'function') return;
        ctx.inject(['sidebarRightTabs'], tabsCtx => {
          tabsCtx.effect(() => tabsCtx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => 'Roblox screenshots',
            guide: [{
              id: 'screenshots',
              order: 60,
              title: () => 'Roblox screenshots',
              description: () => 'Every Studio capture from the lead and its workers, with capture ids to share.',
            }],
          }), 'roblox-screenshots: tab type');
          tabsCtx.effect(() => tabsCtx.slots.inject('sidebar.right.pane.tab', () => tabsCtx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: sessionId => ({ sessionId }) }, ScreenshotsBody,
          )), 'roblox-screenshots: tab body');
          tabsCtx.effect(() => tabsCtx.slots.inject('sidebar.right.pane.tab.title', () => tabsCtx.slots.register(
            { name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ScreenshotsTitle,
          )), 'roblox-screenshots: tab title');
        });
      },
    };
  },
});
