// SlopMaxxer menu bar companion (macOS only, spawned by src/tray.mjs through
// `osascript -l JavaScript`, which ships with macOS, so still zero dependencies).
// Mirrors the Windows tray: clicking the menu bar item opens a phosphor popup with the server's
// ready-made verdict, next task and what is left on each account. It is a window of its own,
// not an NSMenu, because macOS draws menus on glass and dims disabled items.
// No background polling: it fetches once at start, when the popup opens and on "refresh",
// so nobody looking still means no usage requests.
// popupModel() is plain JS so test/tray.test.mjs can run it; run() is the JXA entry point.

const STALE_TITLE_MS = 10 * 60_000; // an old verdict in the menu bar is worse than none
const WIDTH = 400;

// The phosphor theme (public/tokens.css), same as the Windows popup.
const COLORS = {
  bg: '#0B1410', border: '#1A3A2B', txt: '#B8F5CF', muted: '#78B892', faint: '#1F4231',
  accent: '#3DFF8C', ok: '#3DFF8C', warn: '#FFE066', pink: '#FF6BB5', red: '#FF5C5C', hot: '#A98BFF',
  claude: '#FFB86B', codex: '#6BE3FF', muse: '#C792FF',
};

function formatReset(resetsAt, now) {
  if (!resetsAt) return 'not started';
  const mins = (Date.parse(resetsAt) - now) / 60_000;
  if (!Number.isFinite(mins)) return '';
  if (mins <= 0) return 'reset due';
  if (mins >= 1440) return `resets ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `resets ${Math.floor(mins / 60)}h ${Math.floor(mins % 60)}m`;
  return `resets ${Math.ceil(mins)}m`;
}

// Monospaced text at the popup's width, so wrapping by characters is exact enough.
function wrap(text, width = 52) {
  const rows = [];
  let row = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (row && row.length + 1 + word.length > width) { rows.push(row); row = word; } else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows;
}

/** /api/slop body -> { title, tone, items } for the menu bar and popup. Never re-decides the verdict. */
function popupModel(data, now = Date.now(), fetchedAt = now) {
  const v = data?.guidance?.verdict;
  const next = data?.guidance?.next;
  const fresh = now - fetchedAt < STALE_TITLE_MS;
  const title = v?.word && fresh ? `${v.arrow} ${v.word.replace(/\.$/, '')}` : 'slop'; // the bar drops the full stop
  const items = [{ kind: 'header', text: '> slopmaxxer', stamp: data && fetchedAt ? new Date(fetchedAt).toTimeString().slice(0, 8) : '' }];
  if (v?.word) {
    items.push({ kind: 'text', text: '> slop verdict', color: 'muted' });
    items.push({ kind: 'verdict', text: `${v.arrow} ${v.word}`, color: v.tone });
    for (const line of wrap(v.why || '')) items.push({ kind: 'text', text: line, color: 'txt' });
    if (next) items.push({ kind: 'next', lead: 'next task → ', text: next.label ? `${next.slug} ${next.label}` : next.slug, color: next.provider });
    items.push({ kind: 'rule' });
  }
  const accounts = data?.accounts || [];
  if (!data) items.push({ kind: 'text', text: 'SlopMaxxer is not reachable.', color: 'red' });
  else if (!accounts.length) items.push({ kind: 'text', text: 'No logins found yet.', color: 'muted' });
  for (const a of accounts) {
    items.push({ kind: 'account', text: a.label ? `${a.provider}/${a.planSlug} ${a.label}` : `${a.provider}/${a.planSlug}`, color: a.provider });
    if (a.error) items.push({ kind: 'text', text: String(a.error).slice(0, 52), color: 'red' });
    else if (a.stale) items.push({ kind: 'text', text: 'stale - last known values', color: 'muted' });
    let wins = (a.windows || []).filter((w) => w.kind === 'session' || w.kind === 'weekly');
    // Demo/reference snapshots carry fiveHour/weekly aliases instead of a windows array.
    if (!wins.length) wins = [[a.fiveHour, '5-hour'], [a.weekly, 'Weekly']].filter(([w]) => w).map(([w, label]) => ({ label, ...w }));
    if (!wins.length && !a.error) items.push({ kind: 'text', text: 'no limits reported', color: 'muted' });
    for (const w of wins) {
      if (w.usedPct == null) { items.push({ kind: 'bar', label: w.label, left: null, color: a.provider, text: 'unknown', textColor: 'txt' }); continue; }
      const left = Math.max(0, Math.min(100, 100 - w.usedPct));
      const text = !w.active && w.usedPct === 0 ? '100% left, not started' : `${Math.round(left)}% left · ${formatReset(w.resetsAt, now)}`;
      items.push({ kind: 'bar', label: w.label, left, color: a.provider, text, textColor: left <= 0 ? 'red' : left <= 10 ? 'warn' : 'txt' });
    }
    items.push({ kind: 'gap' });
  }
  items.push({ kind: 'actions' });
  return { title, tone: title === 'slop' ? null : v.tone, items };
}

function run(argv) {
  // argv: <api url> <dashboard url> [server pid] [--render <png>]. --render fetches once, draws
  // the popup into a PNG and exits (a check that needs no screen-recording permission).
  const [apiUrl, dashboardUrl] = argv;
  const renderTo = argv.includes('--render') ? argv[argv.indexOf('--render') + 1] : null;
  ObjC.import('Cocoa');
  ObjC.bindFunction('getppid', ['int', []]);
  ObjC.bindFunction('kill', ['int', ['int', 'int']]);
  // osascript's parent is the server; once it dies we are reparented. Prefer the pid the server
  // passed: if it died before this line ran, getppid() would already be the new parent.
  const parentPid = Number(argv[2]) || $.getppid();
  const out = `${$.NSTemporaryDirectory().js}slopmaxxer-menubar-${parentPid}.json`;

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory); // no Dock icon
  const item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);

  const color = (name) => {
    const hex = COLORS[name] || COLORS.txt;
    const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return $.NSColor.colorWithSRGBRedGreenBlueAlpha(n(1), n(3), n(5), 1);
  };
  const mono = (size, bold) => $.NSFont.monospacedSystemFontOfSizeWeight(size, bold ? $.NSFontWeightBold : $.NSFontWeightRegular);
  const styled = (text, fg, font) => {
    const attrs = $.NSMutableDictionary.dictionary;
    attrs.setObjectForKey(font, $.NSFontAttributeName);
    attrs.setObjectForKey(fg, $.NSForegroundColorAttributeName);
    // JXA doesn't bridge initWithString:attributes: on every macOS, so send the selector directly.
    return $.NSAttributedString.alloc.performSelectorWithObjectWithObject('initWithString:attributes:', $(text), attrs);
  };

  // The menu bar takes on the wallpaper's colours, so the title sits on a popup-dark pill
  // to stay readable on any wallpaper in the same colours as the popup. 26pt fills a notch
  // display's taller bar; a 24pt bar (or an auto-hidden one, which reports 0) gets 20pt.
  const pill = (title, fg) => {
    const scr = item.button.window.screen || $.NSScreen.mainScreen, f = scr.frame, v = scr.visibleFrame;
    const bar = f.origin.y + f.size.height - (v.origin.y + v.size.height);
    const font = mono(13, true), text = styled(title, fg, font);
    const size = text.size, h = Math.min(26, Math.max(bar, 24) - 4), padX = h / 2, w = Math.ceil(size.width) + padX * 2;
    // lockFocus bakes the current display's scale; imageWithSize:flipped:drawingHandler: would
    // follow scale changes, but its block draws nothing once AppKit calls it later from JXA.
    const img = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h));
    img.lockFocus;
    color('bg').setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 0, w, h), h / 2, h / 2).fill; // half-circle ends
    // Centre the capitals, not the line box (which carries descender space below them).
    text.drawAtPoint($.NSMakePoint(padX, (h - font.capHeight) / 2 + font.descender));
    img.unlockFocus;
    return img;
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

  ObjC.registerSubclass({ name: 'SlopFlippedView', superclass: 'NSView', methods: { isFlipped: { types: ['bool', []], implementation: () => true } } });

  // Non-activating: the popup never takes focus from the app you're in (macOS won't hand it
  // over without a real click anyway), and its buttons still work.
  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, WIDTH, 100), $.NSWindowStyleMaskBorderless | $.NSWindowStyleMaskNonactivatingPanel, $.NSBackingStoreBuffered, false);
  panel.hidesOnDeactivate = false;
  panel.level = $.NSPopUpMenuWindowLevel;
  panel.hasShadow = true;
  panel.backgroundColor = color('border'); // shows as the 1px frame around the content box
  panel.releasedWhenClosed = false;

  const box = (parent, x, y, w, h, fill) => {
    const b = $.NSBox.alloc.initWithFrame($.NSMakeRect(x, y, w, h));
    b.boxType = $.NSBoxCustom;
    b.borderWidth = 0;
    b.fillColor = color(fill);
    parent.addSubview(b);
    return b;
  };
  const label = (parent, text, fg, font, x, y, w, h = 15, align) => {
    const l = $.NSTextField.labelWithAttributedString(styled(text, color(fg), font));
    l.frame = $.NSMakeRect(x, y, w, h);
    if (align) l.alignment = align;
    parent.addSubview(l);
    return l;
  };
  const link = (parent, text, fg, x, y, selector) => {
    const b = $.NSButton.alloc.initWithFrame($.NSMakeRect(x, y, text.length * 7 + 8, 18));
    b.bordered = false;
    b.attributedTitle = styled(text, color(fg), mono(11, true));
    b.target = target;
    b.action = selector;
    parent.addSubview(b);
  };

  // Top-down layout in a flipped view, the same sizes as the Windows popup.
  const buildPopup = () => {
    const model = popupModel(data, Date.now(), fetchedAt);
    const view = $.SlopFlippedView.alloc.initWithFrame($.NSMakeRect(0, 0, WIDTH, 100));
    const inner = $.SlopFlippedView.alloc.initWithFrame($.NSMakeRect(1, 1, WIDTH - 2, 100));
    view.addSubview(inner);
    box(inner, 0, 0, WIDTH - 2, 4000, 'bg');
    let y = 8;
    for (const it of model.items) {
      if (it.kind === 'header') {
        label(inner, it.text, 'accent', mono(13, true), 12, y, 200, 18);
        // While fetching, the status takes the timestamp slot, so the popup keeps its height.
        label(inner, task ? 'fetching…' : it.stamp, task ? 'accent' : 'muted', mono(11), WIDTH - 110, y + 2, 96, 15, $.NSTextAlignmentRight);
        y += 24;
      } else if (it.kind === 'verdict') {
        label(inner, it.text, it.color, mono(19, true), 12, y, 376, 26);
        y += 28;
      } else if (it.kind === 'next') {
        label(inner, it.lead, 'muted', mono(12, true), 12, y, 110, 17);
        label(inner, it.text, it.color, mono(12, true), 12 + it.lead.length * 7.3, y, 280, 17);
        y += 20;
      } else if (it.kind === 'rule') {
        box(inner, 12, y + 2, 376, 1, 'faint');
        y += 11;
      } else if (it.kind === 'account') {
        label(inner, it.text, it.color, mono(12, true), 12, y, 376, 17);
        y += 17;
      } else if (it.kind === 'bar') {
        label(inner, String(it.label), 'muted', mono(11), 12, y + 1, 58);
        box(inner, 72, y + 4, 112, 9, 'faint');
        if (it.left != null) box(inner, 72, y + 4, Math.round(112 * it.left / 100), 9, it.color);
        label(inner, it.text, it.textColor, mono(11), 190, y + 1, 202);
        y += 16;
      } else if (it.kind === 'gap') {
        y += 7;
      } else if (it.kind === 'actions') {
        link(inner, 'open dashboard', 'accent', 8, y, 'openDashboard:');
        link(inner, 'refresh', 'muted', 128, y, 'refresh:');
        link(inner, 'quit', 'muted', 196, y, 'quit:');
        y += 26;
      } else {
        label(inner, it.text, it.color, mono(11), 12, y, 376);
        y += 16;
      }
    }
    inner.frame = $.NSMakeRect(1, 1, WIDTH - 2, y);
    view.frame = $.NSMakeRect(0, 0, WIDTH, y + 2);
    return { model, view, height: y + 2 };
  };

  const render = () => {
    const model = popupModel(data, Date.now(), fetchedAt);
    item.button.image = pill(model.title, color(model.tone || 'txt'));
    item.button.setAccessibilityLabel(model.title); // the image has no text for VoiceOver
    if (!panel.isVisible) return;
    const { view, height } = buildPopup();
    // Under the menu bar item, kept on screen.
    const btn = item.button.window.frame;
    const screen = item.button.window.screen.visibleFrame;
    const x = Math.max(screen.origin.x + 4, Math.min(btn.origin.x, screen.origin.x + screen.size.width - WIDTH - 4));
    panel.setFrameDisplay($.NSMakeRect(x, btn.origin.y - height - 4, WIDTH, height), true);
    panel.contentView = view;
  };

  const close = () => panel.orderOut(null);
  // A click in any other app closes it. Watching mouse clicks needs no Accessibility permission.
  // Clicks on our own menu bar item arrive here too; toggle: handles those.
  $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler($.NSEventMaskLeftMouseDown | $.NSEventMaskRightMouseDown, () => {
    const p = $.NSEvent.mouseLocation, f = item.button.window.frame;
    if (p.x >= f.origin.x && p.x <= f.origin.x + f.size.width && p.y >= f.origin.y && p.y <= f.origin.y + f.size.height) return;
    close();
  });

  ObjC.registerSubclass({
    name: 'SlopMenuBarTarget',
    methods: {
      'toggle:': {
        types: ['void', ['id']],
        implementation: () => {
          if (panel.isVisible) { close(); return; }
          fetchNow();
          panel.orderFrontRegardless;
          render();
        },
      },
      'openDashboard:': { types: ['void', ['id']], implementation: () => { close(); $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(dashboardUrl)); } },
      'refresh:': { types: ['void', ['id']], implementation: () => { fetchNow(); render(); } },
      'quit:': { types: ['void', ['id']], implementation: () => { $.kill(parentPid, 15); app.terminate(null); } },
      'tick:': {
        types: ['void', ['id']],
        implementation: () => {
          if ($.getppid() !== parentPid) app.terminate(null);
          if (fetchDone()) {
            titleCleared = false;
            if (renderTo) {
              const { view } = buildPopup();
              const rep = view.bitmapImageRepForCachingDisplayInRect(view.bounds);
              view.cacheDisplayInRectToBitmapImageRep(view.bounds, rep);
              rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(renderTo, true);
              console.log(`[title] ${popupModel(data, Date.now(), fetchedAt).title}\n[png] ${renderTo}`);
              app.terminate(null);
            }
            render();
          }
          else if (!task && !titleCleared && fetchedAt && Date.now() - fetchedAt >= STALE_TITLE_MS) { titleCleared = true; render(); }
        },
      },
    },
  });
  const target = $.SlopMenuBarTarget.alloc.init;
  item.button.target = target;
  item.button.action = 'toggle:';

  // Common modes, so the timer also fires while the popup is open and fills it in live.
  const timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.5, target, 'tick:', null, true);
  $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);

  fetchNow();
  render();
  app.run;
}
