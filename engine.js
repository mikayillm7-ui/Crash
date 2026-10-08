// Game engine shared by the server (authoritative) and the offline demo page.
// Games: shared crash room, balloon pop, mines, rock-paper-scissors (online PvP + vs computer).
// Coins are free play-money. They are NOT convertible to cash (points are a separate currency, see server.js).
function createEngine(opts) {
  opts = opts || {};
  var RATE = 0.00012, MIN_BET = 10, PVP_TIERS = [10, 20, 50, 100, 200, 500];
  var BREAK_MS = 6000, BET_MS = 8000, END_MS = 4000;          // crash room phases
  var RPS_PICK_MS = 20000, RPS_WAIT_MS = 30000;               // PvP timings
  var now = opts.now || Date.now, onFinish = opts.onFinish || function () {}, sha = opts.sha256 || null;
  var active = {};
  function err(m) { return { error: m }; }
  function rnd() { return Math.random(); }
  function genCrash() { var r = rnd(); return Math.max(1, Math.floor(99 / (1 - r)) / 100); }
  function pay(u, ret) { u.coins += ret; u.weekNet += ret; }
  function take(u, bet) { u.coins -= bet; u.weekNet -= bet; }
  function done(u, extra) { extra.coins = u.coins; extra.weekBest = u.weekNet; return extra; }
  function checkBet(u, bet, tiers) {
    bet = Math.floor(Number(bet));
    if (!(bet >= MIN_BET)) return err("حداقل شرط " + MIN_BET + " سکه است.");
    if (bet > u.coins) return err("سکه‌ات کافی نیست.");
    if (tiers && tiers.indexOf(bet) < 0) return err("برای بازی آنلاین یکی از مبلغ‌های " + tiers.join("، ") + " را انتخاب کن.");
    return bet;
  }
  var E = {};

  // =============== shared crash room ===============
  var R = { id: 0, phase: "break", phaseStart: now(), start: 0, crashAt: 0, salt: "", hash: "", bets: [], next: [], history: [], last: null };
  function crashM() { return Math.exp(RATE * (now() - R.start)); }
  function endBet(b, mult, win) {
    b.state = win > 0 ? "cashed" : "lost"; b.mult = mult; b.win = win; if (win > 0) pay(b.u, win);
    onFinish({ user: b.u, game: "crash", bet: b.bet, mult: mult, win: win });
  }
  function sweepAuto(m) {
    R.bets.forEach(function (b) { if (b.state === "open" && b.auto && b.auto <= m && b.auto < R.crashAt) endBet(b, b.auto, Math.floor(b.bet * b.auto)); });
  }
  function findBet(list, key) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return i; return -1; }
  function toBet() {
    R.id++; R.phase = "bet"; R.phaseStart = now(); R.crashAt = genCrash();
    R.salt = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    R.hash = sha ? sha(R.crashAt.toFixed(2) + ":" + R.salt) : ""; R.bets = R.next; R.next = [];
  }
  function toRun() { R.phase = "run"; R.start = now(); R.phaseStart = R.start; }
  function toCrashed() {
    sweepAuto(R.crashAt);
    R.bets.forEach(function (b) { if (b.state === "open") endBet(b, null, 0); });
    R.phase = "crashed"; R.phaseStart = now(); R.last = R.crashAt; R.history.unshift(R.crashAt); R.history.length = Math.min(R.history.length, 12);
  }
  function toBreak() { R.phase = "break"; R.phaseStart = now(); R.bets = []; }

  E.tick = function () {
    var t = now(), p = R.phase;
    if (p === "break" && t - R.phaseStart >= BREAK_MS) toBet();
    else if (p === "bet" && t - R.phaseStart >= BET_MS) toRun();
    else if (p === "run") { var m = crashM(); sweepAuto(m); if (m >= R.crashAt) toCrashed(); }
    else if (p === "crashed" && t - R.phaseStart >= END_MS) toBreak();
    rpsTick(t);
  };
  E.roomBet = function (key, u, bet, auto) {
    var b = checkBet(u, bet); if (b.error) return b;
    var target = R.phase === "bet" ? R.bets : R.next;
    if (findBet(target, key) >= 0) return err("برای این دور شرط بسته‌ای.");
    auto = Number(auto) >= 1.01 ? Math.min(Number(auto), 1000) : null;
    take(u, b); target.push({ key: key, u: u, bet: b, auto: auto, state: "open", mult: null, win: 0 });
    return { coins: u.coins, queued: R.phase !== "bet" };
  };
  E.roomCancel = function (key, u) {
    var i = findBet(R.next, key), b;
    if (i >= 0) { b = R.next.splice(i, 1)[0]; }
    else if (R.phase === "bet" && (i = findBet(R.bets, key)) >= 0) { b = R.bets.splice(i, 1)[0]; }
    else return err("شرطی برای لغو نیست.");
    u.coins += b.bet; u.weekNet += b.bet; return { coins: u.coins };
  };
  E.roomCash = function (key, u) {
    if (R.phase !== "run") return err("الان نمی‌شود برداشت کرد.");
    var i = findBet(R.bets, key); if (i < 0 || R.bets[i].state !== "open") return err("شرط بازی نداری.");
    var m = crashM();
    if (m >= R.crashAt) return { ok: false, crashed: true, coins: u.coins };
    var b = R.bets[i], win = Math.floor(b.bet * m); endBet(b, m, win);
    return done(u, { ok: true, m: m, win: win });
  };
  E.roomState = function (key) {
    var t = now(), dur = { break: BREAK_MS, bet: BET_MS, crashed: END_MS, run: 0 }[R.phase];
    var s = { id: R.id, phase: R.phase, elapsed: R.phase === "run" ? t - R.start : 0, left: dur ? Math.max(0, dur - (t - R.phaseStart)) : 0,
      history: R.history, hash: R.hash, queuedCount: R.next.length };
    if (R.phase === "crashed") { s.crashAt = R.crashAt; s.salt = R.salt; }
    s.players = R.bets.slice(0, 40).map(function (b) { return { name: b.u.display, bet: b.bet, mult: b.mult, win: b.win, state: b.state }; });
    var i = findBet(R.bets, key), q = false;
    if (i < 0) { i = findBet(R.next, key); q = i >= 0; }
    var b = i >= 0 ? (q ? R.next[i] : R.bets[i]) : null;
    s.queuedMe = findBet(R.next, key) >= 0; s.nextBet = s.queuedMe ? R.next[findBet(R.next, key)].bet : 0;
    s.me = b ? { bet: b.bet, auto: b.auto, queued: q, state: b.state, mult: b.mult, win: b.win } : null;
    return s;
  };

  // =============== balloon pop ===============
  function popMult(n) { return Math.floor(Math.pow(1.18, n) * 100) / 100; }
  function settle(key, u, mult, win) { var g = active[key]; delete active[key]; onFinish({ user: u, game: g.type, bet: g.bet, mult: mult, win: win }); }
  function begin(key, u, bet, g) {
    var b = checkBet(u, bet); if (b.error) return b;
    if (active[key]) settle(key, u, null, 0);            // abandoned round counts as a loss
    take(u, b); g.bet = b; active[key] = g; return b;
  }
  function cur(key, type) { var g = active[key]; return g && g.type === type ? g : null; }
  E.popStart = function (key, u, bet) { var b = begin(key, u, bet, { type: "pop", popAt: genCrash(), n: 0 }); return b.error ? b : { coins: u.coins, next: popMult(1) }; };
  E.popPump = function (key, u) {
    var g = cur(key, "pop"); if (!g) return err("دور فعالی نیست.");
    var n = g.n + 1, m = popMult(n);
    if (m >= g.popAt) { var pa = g.popAt; settle(key, u, null, 0); return { popped: true, popAt: pa, n: n, coins: u.coins }; }
    g.n = n; return { popped: false, n: n, m: m, next: popMult(n + 1) };
  };
  E.popCash = function (key, u) {
    var g = cur(key, "pop"); if (!g) return err("دور فعالی نیست."); if (g.n < 1) return err("حداقل یک بار پمپ کن.");
    var m = popMult(g.n), win = Math.floor(g.bet * m); pay(u, win); settle(key, u, m, win); return done(u, { ok: true, m: m, win: win });
  };

  // =============== mines (5x5) ===============
  function minesMult(r, k) { var m = 0.99; for (var i = 0; i < r; i++) m *= (25 - i) / (25 - k - i); return Math.floor(m * 100) / 100; }
  E.minesStart = function (key, u, bet, k) {
    k = Math.min(10, Math.max(1, Math.floor(Number(k)) || 3));
    var cells = []; for (var i = 0; i < 25; i++) cells.push(i);
    for (var j = 24; j > 0; j--) { var x = Math.floor(rnd() * (j + 1)), t = cells[j]; cells[j] = cells[x]; cells[x] = t; }
    var b = begin(key, u, bet, { type: "mines", k: k, mines: cells.slice(0, k), rev: [] }); return b.error ? b : { coins: u.coins, k: k, next: minesMult(1, k) };
  };
  E.minesReveal = function (key, u, idx) {
    var g = cur(key, "mines"); if (!g) return err("دور فعالی نیست.");
    idx = Math.floor(Number(idx)); if (!(idx >= 0 && idx < 25) || g.rev.indexOf(idx) >= 0) return err("خانه‌ی نامعتبر.");
    if (g.mines.indexOf(idx) >= 0) { var ms = g.mines; settle(key, u, null, 0); return { boom: true, mines: ms, coins: u.coins }; }
    g.rev.push(idx); var r = g.rev.length, m = minesMult(r, g.k);
    if (r === 25 - g.k) { var ms2 = g.mines, win = Math.floor(g.bet * m); pay(u, win); settle(key, u, m, win); return done(u, { boom: false, done: true, m: m, win: win, mines: ms2 }); }
    return { boom: false, r: r, m: m, next: minesMult(r + 1, g.k) };
  };
  E.minesCash = function (key, u) {
    var g = cur(key, "mines"); if (!g) return err("دور فعالی نیست."); if (g.rev.length < 1) return err("حداقل یک خانه را باز کن.");
    var m = minesMult(g.rev.length, g.k), win = Math.floor(g.bet * m), ms = g.mines; pay(u, win); settle(key, u, m, win);
    return done(u, { ok: true, m: m, win: win, mines: ms });
  };

  // =============== rock paper scissors ===============
  // vs computer: win pays 1.97x, tie refunds
  E.rpsPlay = function (key, u, bet, choice) {
    choice = Math.floor(Number(choice)); if (!(choice >= 0 && choice <= 2)) return err("انتخاب نامعتبر.");
    var b = checkBet(u, bet); if (b.error) return b;
    take(u, b); var cpu = Math.floor(rnd() * 3), d = (choice - cpu + 3) % 3;
    var ret = d === 1 ? Math.floor(b * 1.97) : d === 0 ? b : 0; pay(u, ret);
    onFinish({ user: u, game: "rps", bet: b, mult: ret ? ret / b : null, win: ret });
    return done(u, { cpu: cpu, result: d === 1 ? "win" : d === 0 ? "tie" : "lose", ret: ret });
  };
  // online PvP: same bet tier, winner gets 95% of the pot, tie refunds both
  var queue = {}, matches = [], byKey = {}, notes = {};
  function removeFromQueue(key) { for (var bet in queue) { var i = findBet(queue[bet], key); if (i >= 0) return queue[bet].splice(i, 1)[0]; } return null; }
  E.rpsQueue = function (key, u, bet) {
    if (byKey[key]) return err("یک بازی آنلاین در جریان است.");
    var b = checkBet(u, bet, PVP_TIERS); if (b.error) return b;
    for (var q in queue) if (findBet(queue[q], key) >= 0) return err("در صف هستی.");
    take(u, b); delete notes[key];
    var list = queue[b] || (queue[b] = []);
    if (list.length) {
      var other = list.shift(), m = { bet: b, p: [{ key: other.key, u: other.u, choice: null }, { key: key, u: u, choice: null }], deadline: now() + RPS_PICK_MS, over: false, res: null };
      matches.push(m); byKey[other.key] = m; byKey[key] = m; return { status: "match" };
    }
    list.push({ key: key, u: u, bet: b, at: now() }); return { status: "waiting" };
  };
  E.rpsCancelQueue = function (key, u) { var w = removeFromQueue(key); if (!w) return err("در صف نیستی."); u.coins += w.bet; u.weekNet += w.bet; return { coins: u.coins, weekBest: u.weekNet }; };
  function closeMatch(m, retA, retB, why) {
    m.over = true; m.res = [{ ret: retA }, { ret: retB }];
    [retA, retB].forEach(function (ret, i) { var p = m.p[i]; pay(p.u, ret); onFinish({ user: p.u, game: "rps_pvp", bet: m.bet, mult: ret ? ret / m.bet : null, win: ret }); });
    m.why = why;
  }
  function resolveMatch(m) {
    var a = m.p[0], b = m.p[1], d = (a.choice - b.choice + 3) % 3, pot = Math.floor(m.bet * 2 * 0.95);
    if (d === 0) closeMatch(m, m.bet, m.bet, "tie"); else if (d === 1) closeMatch(m, pot, 0, "win"); else closeMatch(m, 0, pot, "win");
  }
  E.rpsChoose = function (key, u, choice) {
    var m = byKey[key]; if (!m || m.over) return err("بازی آنلاین فعالی نیست.");
    choice = Math.floor(Number(choice)); if (!(choice >= 0 && choice <= 2)) return err("انتخاب نامعتبر.");
    var me = m.p[0].key === key ? m.p[0] : m.p[1]; if (me.choice !== null) return err("قبلاً انتخاب کرده‌ای.");
    me.choice = choice; if (m.p[0].choice !== null && m.p[1].choice !== null) resolveMatch(m); return { ok: true };
  };
  E.rpsStatus = function (key, u) {
    var m = byKey[key];
    if (m) {
      var i = m.p[0].key === key ? 0 : 1, me = m.p[i], opp = m.p[1 - i];
      if (!m.over) return { status: "match", bet: m.bet, leftMs: Math.max(0, m.deadline - now()), youChose: me.choice !== null };
      delete byKey[key];
      var ret = m.res[i].ret, result = ret > m.bet ? "win" : ret === m.bet ? "tie" : "lose";
      return done(u, { status: "done", result: result, ret: ret, yours: me.choice, theirs: opp.choice, forfeit: m.why === "forfeit" });
    }
    if (notes[key]) { var n = notes[key]; delete notes[key]; return done(u, { status: n }); }
    for (var q in queue) { var j = findBet(queue[q], key); if (j >= 0) return { status: "waiting", waitedMs: now() - queue[q][j].at, bet: queue[q][j].bet }; }
    return { status: "idle" };
  };
  function rpsTick(t) {
    for (var q in queue) { for (var i = queue[q].length - 1; i >= 0; i--) { var w = queue[q][i]; if (t - w.at >= RPS_WAIT_MS) { queue[q].splice(i, 1); w.u.coins += w.bet; w.u.weekNet += w.bet; notes[w.key] = "timeout"; } } }
    for (var k = matches.length - 1; k >= 0; k--) {
      var m = matches[k];
      if (m.over) { if (t - m.deadline > 60000) matches.splice(k, 1); continue; }
      if (t >= m.deadline) {
        var a = m.p[0], b = m.p[1], pot = Math.floor(m.bet * 2 * 0.95);
        if (a.choice === null && b.choice === null) closeMatch(m, m.bet, m.bet, "tie");
        else if (a.choice === null) closeMatch(m, 0, pot, "forfeit");
        else closeMatch(m, pot, 0, "forfeit");
      }
    }
  }
  return E;
}
if (typeof module !== "undefined") module.exports = createEngine;
