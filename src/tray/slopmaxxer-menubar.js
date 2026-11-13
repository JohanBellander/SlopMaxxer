// SlopMaxxer menu bar companion (macOS only, spawned by src/tray.mjs through
// `osascript -l JavaScript`, which ships with macOS, so still zero dependencies).
// Mirrors the Windows tray: the server's ready-made verdict, next task and what is left
// on each account. No background polling: it fetches once at start, when the menu opens
// and on "Refresh now", so nobody looking still means no usage requests.
// menuModel() is plain JS so test/tray.test.mjs can run it; run() is the JXA entry point.

const STALE_TITLE_MS = 10 * 60_000; // an old verdict in the menu bar is worse than none

function formatReset(resetsAt, now) {
  if (!resetsAt) return 'not started';
  const mins = (Date.parse(resetsAt) - now) / 60_000;
  if (!Number.isFinite(mins)) return '';
  if (mins <= 0) return 'reset due';
  if (mins >= 1440) return `resets ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `resets ${Math.floor(mins / 60)}h ${Math.floor(mins % 60)}m`;
  return `resets ${Math.ceil(mins)}m`;
}

// Menu items don't wrap, so long text becomes several rows.
function wrap(text, width = 64) {
  const rows = [];
  let row = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (row && row.length + 1 + word.length > width) { rows.push(row); row = word; } else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows;
}

function meter(leftPct, cells = 10) {
  const full = Math.round((leftPct / 100) * cells);
  return '█'.repeat(full) + '░'.repeat(cells - full);
}

/** /api/slop body -> { title, rows: [{ text, color?, bold?, sep? }] }. Never re-decides the verdict. */
function menuModel(data, now = Date.now(), fetchedAt = now) {
  const rows = [];
  if (!data) return { title: 'slop', rows: [{ text: 'SlopMaxxer is not reachable.', color: 'red' }] };
  const v = data.guidance?.verdict;
  const next = data.guidance?.next;
  const fresh = now - fetchedAt < STALE_TITLE_MS;
  const title = v?.word && fresh ? `${v.arrow} ${v.word}` : 'slop';
  if (v?.word) {
    rows.push({ text: '> slop verdict', color: 'muted' });
    rows.push({ text: `${v.arrow} ${v.word}`, color: v.tone, bold: true });
    for (const line of wrap(v.why || '')) rows.push({ text: line });
    if (next) rows.push({ text: `next task → ${next.label ? `${next.slug} ${next.label}` : next.slug}`, color: next.provider, bold: true });
    rows.push({ sep: true });
  }
  const accounts = data.accounts || [];
  if (!accounts.length) rows.push({ text: 'No logins found yet.', color: 'muted' });
  for (const a of accounts) {
    rows.push({ text: a.label ? `${a.provider}/${a.planSlug} ${a.label}` : `${a.provider}/${a.planSlug}`, color: a.provider, bold: true });
    if (a.error) rows.push({ text: `  ${String(a.error).slice(0, 60)}`, color: 'red' });
    else if (a.stale) rows.push({ text: '  stale - last known values', color: 'muted' });
    let wins = (a.windows || []).filter((w) => w.kind === 'session' || w.kind === 'weekly');
    // Demo/reference snapshots carry fiveHour/weekly aliases instead of a windows array.
    if (!wins.length) wins = [[a.fiveHour, '5-hour'], [a.weekly, 'Weekly']].filter(([w]) => w).map(([w, label]) => ({ label, ...w }));
    if (!wins.length && !a.error) rows.push({ text: '  no limits reported', color: 'muted' });
    for (const w of wins) {
      const name = String(w.label).padEnd(7);
      if (w.usedPct == null) { rows.push({ text: `  ${name} unknown`, color: 'muted' }); continue; }
      const left = Math.max(0, Math.min(100, 100 - w.usedPct));
      const text = !w.active && w.usedPct === 0
        ? `  ${name} ${meter(100)} 100% left, not started`
        : `  ${name} ${meter(left)} ${Math.round(left)}% left · ${formatReset(w.resetsAt, now)}`;
      rows.push({ text, color: left <= 0 ? 'red' : left <= 10 ? 'warn' : undefined });
    }
  }
  return { title, rows };
}

function run(argv) {
  // --dump: build the real menu once, print it and exit (a check that needs no screen access).
  const [apiUrl, dashboardUrl, mode] = argv;
  const dump = mode === '--dump';
  ObjC.import('Cocoa');
  ObjC.bindFunction('getppid', ['int', []]);
  const parentPid = $.getppid(); // osascript's parent is the server; it becomes 1 if that dies
  const out = `${$.NSTemporaryDirectory().js}slopmaxxer-menubar-${parentPid}.json`;

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory); // no Dock icon
  const item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  const menu = $.NSMenu.alloc.init;
  menu.autoenablesItems = false;
  item.menu = menu;

  const colors = {
    pink: $.NSColor.systemPinkColor, ok: $.NSColor.systemGreenColor, warn: $.NSColor.systemOrangeColor,
    red: $.NSColor.systemRedColor, muted: $.NSColor.secondaryLabelColor,
    claude: $.NSColor.systemOrangeColor, codex: $.NSColor.systemTealColor, muse: $.NSColor.systemPurpleColor,
  };
  const font = (bold) => $.NSFont.monospacedSystemFontOfSizeWeight(12, bold ? $.NSFontWeightBold : $.NSFontWeightRegular);
  const styled = (text, color, bold) => {
    const attrs = $.NSMutableDictionary.dictionary;
    attrs.setObjectForKey(font(bold), $.NSFontAttributeName);
    attrs.setObjectForKey(colors[color] || $.NSColor.labelColor, $.NSForegroundColorAttributeName);
    // JXA doesn't bridge initWithString:attributes: on every macOS, so send the selector directly.
    return $.NSAttributedString.alloc.performSelectorWithObjectWithObject('initWithString:attributes:', $(text), attrs);
  };

  let data = null;
  let fetchedAt = 0;
  let task = null;
  let titleCleared = false; // an old verdict was swapped for the neutral title

  const fetchNow = () => {
    if (task) return;
    task = $.NSTask.alloc.init;
    task.launchPath = '/usr/bin/curl';
    task.arguments = ['-sf', '-m', '25', '-o', out, apiUrl];
    task.launch;
  };
  const fetchDone = () => {
    if (!task || task.isRunning) return false;
    const ok = task.terminationStatus === 0;
    task = null;
    const raw = ok ? $.NSString.stringWithContentsOfFileEncodingError(out, $.NSUTF8StringEncoding, null) : null;
    try { data = raw && !raw.isNil() ? JSON.parse(raw.js) : null; } catch { data = null; }
    fetchedAt = Date.now();
    $.NSFileManager.defaultManager.removeItemAtPathError(out, null);
    return true;
  };

  const render = () => {
    const model = menuModel(data, Date.now(), fetchedAt);
    item.button.attributedTitle = styled(model.title, model.title === 'slop' ? undefined : data?.guidance?.verdict?.tone, true);
    menu.removeAllItems;
    if (task) menu.addItem(info('fetching…', 'muted'));
    for (const r of model.rows) menu.addItem(r.sep ? $.NSMenuItem.separatorItem : info(r.text, r.color, r.bold));
    menu.addItem($.NSMenuItem.separatorItem);
    menu.addItem(action('Open dashboard', 'openDashboard:'));
    menu.addItem(action('Refresh now', 'refresh:'));
    menu.addItem(action('Quit SlopMaxxer', 'quit:'));
  };

  ObjC.registerSubclass({
    name: 'SlopMenuBarTarget',
    protocols: ['NSMenuDelegate'],
    methods: {
      'openDashboard:': { types: ['void', ['id']], implementation: () => $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(dashboardUrl)) },
      'refresh:': { types: ['void', ['id']], implementation: () => { fetchNow(); render(); } },
      'quit:': { types: ['void', ['id']], implementation: () => { $.kill(parentPid, 15); app.terminate(null); } },
      'menuWillOpen:': { types: ['void', ['id']], implementation: () => { fetchNow(); render(); } },
      'tick:': {
        types: ['void', ['id']],
        implementation: () => {
          if ($.getppid() !== parentPid) app.terminate(null);
          if (fetchDone()) {
            titleCleared = false;
            render();
            if (dump) {
              const lines = [`[title] ${item.button.title.js}`];
              for (let i = 0; i < menu.numberOfItems; i++) lines.push(menu.itemAtIndex(i).title.js || '---');
              console.log(lines.join('\n'));
              app.terminate(null);
            }
          }
          else if (!task && !titleCleared && fetchedAt && Date.now() - fetchedAt >= STALE_TITLE_MS) { titleCleared = true; render(); }
        },
      },
    },
  });
  ObjC.bindFunction('kill', ['int', ['int', 'int']]);
  const target = $.SlopMenuBarTarget.alloc.init;
  menu.delegate = target;

  function info(text, color, bold) {
    const mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(text, null, '');
    mi.attributedTitle = styled(text, color, bold);
    mi.enabled = false;
    return mi;
  }
  function action(title, selector) {
    const mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, selector, '');
    mi.target = target;
    return mi;
  }

  // Common modes, so the timer also fires while the menu is open and fills it in live.
  const timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, target, 'tick:', null, true);
  $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);

  if (dump) target.menuWillOpen(menu); // the same path a click takes
  else fetchNow();
  render();
  app.run;
}
