// The page loads, boots and shows the login form; no script errors.
export const meta = { about: 'page boots, login form shown, no script errors', ssh: false };

export async function run({ b, t }) {
  const s = await b.ev(`({ form: !document.getElementById('ov').classList.contains('h'),
    config: !!serverConfig, xterm: typeof Terminal, panes: Object.keys(panes).length })`);
  t.ok(s.config, 'config loaded');
  t.ok(s.form && s.panes === 0, 'login form on an empty workspace');
  t.ok(s.xterm === 'function', 'xterm.js loaded');
}
