// Arena server: accounts, referrals, shared crash room, PvP rock-paper-scissors,
// weekly leaderboard, and a points shop (points are separate from play-coins).
// No dependencies. Run: node server.js   (Node 18+)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const createEngine = require("./engine.js");

// ---- configuration (environment variables)
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";                           // required for /api/admin/*
const DB = path.join(process.env.DATA_DIR || __dirname, "data.json");    // point DATA_DIR at a persistent disk
const POINT_TOMAN_PER_1000 = Number(process.env.POINT_TOMAN_PER_1000 || 1000);  // value of 1000 points in toman
const WEEKLY_BUDGET = Number(process.env.WEEKLY_BUDGET || 0);            // toman you allow to pay out per week. 0 = shop closed
const MAX_USER_WEEK_TOMAN = Number(process.env.MAX_USER_WEEK_TOMAN || 100000);
const MIN_REDEEM_POINTS = 5000, MIN_ACCOUNT_DAYS = 7, MIN_ROUNDS = 100;
const START_COINS = 100, REF_BONUS = 100, REF_CAP = 20;
const AD_REWARD = 10, AD_POINTS = 1, AD_COOLDOWN_MS = 30000, AD_DAILY_CAP = 30;
const RANK_POINTS = [500, 300, 200, 100, 100, 50, 50, 50, 50, 50];       // paid at week end to top 10 with positive net

let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : { users: {}, sessions: {} };
db.meta = db.meta || { week: null, paid: {} }; db.requests = db.requests || [];
let dirty = false;
setInterval(() => { if (dirty) { fs.writeFileSync(DB + ".tmp", JSON.stringify(db)); fs.renameSync(DB + ".tmp", DB); dirty = false; } }, 2000);
const save = () => { dirty = true; };
const feed = [], regLog = {};
const today = () => new Date().toISOString().slice(0, 10);
function weekId() { const d = new Date(); const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + "-" + Math.floor(((d - j) / 864e5 + j.getUTCDay()) / 7); }
if (!db.meta.week) db.meta.week = weekId();

const E = createEngine({
  sha256: (x) => crypto.createHash("sha256").update(x).digest("hex"),
  onFinish(ev) {
    const u = ev.user;
    u.rounds = (u.rounds || 0) + 1; u.todayRounds = (u.todayRounds || 0) + 1;
    if (u.todayRounds === 10) u.points = (u.points || 0) + 5;                              // daily mission
    if (u.rounds === 30 && u.refBy && db.users[u.refBy]) db.users[u.refBy].points = (db.users[u.refBy].points || 0) + 20;   // qualified referral
    feed.unshift({ game: ev.game, name: u.display, bet: ev.bet, mult: ev.mult, win: ev.win }); feed.length = Math.min(feed.length, 20);
    save();
  },
});
setInterval(() => E.tick(), 100);

// weekly rollover: reward the top of last week with points
setInterval(() => {
  const w = weekId(); if (db.meta.week === w) return;
  const old = db.meta.week;
  Object.values(db.users).filter((u) => u.week === old && u.weekNet > 0).sort((a, b) => b.weekNet - a.weekNet).slice(0, RANK_POINTS.length)
    .forEach((u, i) => { u.points = (u.points || 0) + RANK_POINTS[i]; });
  db.meta.week = w; save();
}, 60000);

function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString("hex"); }
function refresh(u) {
  if (u.day !== today()) { u.day = today(); u.adsToday = 0; u.todayRounds = 0; if (u.coins < START_COINS) u.coins = START_COINS; }
  if (u.week !== weekId()) { u.week = weekId(); u.weekNet = 0; }
}
function pub(u) { return { username: u.display, coins: u.coins, weekBest: u.weekNet, points: u.points || 0, refCode: u.refCode, refCount: u.refCount, adsLeft: AD_DAILY_CAP - u.adsToday }; }
function auth(req) { const t = (req.headers.authorization || "").replace("Bearer ", ""); const n = db.sessions[t]; if (!n || !db.users[n]) return null; const u = db.users[n]; refresh(u); u.seen = Date.now(); return { name: n, u }; }
function body(req) { return new Promise((ok) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 5000) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); }
const game = (fn) => async (req, res) => {
  const a = auth(req); if (!a) return send(res, 401, { error: "وارد شو." });
  const b = req.method === "POST" ? await body(req) : {};
  const r = fn(a.name, a.u, b); if (r.error) return send(res, 400, r); save(); send(res, 200, r);
};

// ---- shop
function shopInfo(u) {
  const used = db.meta.paid[weekId()] || 0;
  return { open: WEEKLY_BUDGET > 0, rate: POINT_TOMAN_PER_1000, minPoints: MIN_REDEEM_POINTS, points: u.points || 0, budgetLeft: Math.max(0, WEEKLY_BUDGET - used),
    need: { days: MIN_ACCOUNT_DAYS, rounds: MIN_ROUNDS }, have: { days: Math.floor((Date.now() - (u.created || Date.now())) / 864e5), rounds: u.rounds || 0 },
    maxWeek: MAX_USER_WEEK_TOMAN, reqs: (u.reqs || []).slice(-5).reverse() };
}
function redeem(name, u, b) {
  const used = db.meta.paid[weekId()] || 0, pts = Math.floor(Number(b.points)), contact = String(b.contact || "").trim();
  if (WEEKLY_BUDGET <= 0) return { error: "فروشگاه فعلاً بسته است." };
  if (!(pts >= MIN_REDEEM_POINTS) || pts % 1000 !== 0) return { error: "حداقل " + MIN_REDEEM_POINTS + " امتیاز و مضرب ۱۰۰۰." };
  if (pts > (u.points || 0)) return { error: "امتیازت کافی نیست." };
  if (contact.length < 3 || contact.length > 60) return { error: "راه ارتباطی (آیدی تلگرام یا شماره) را وارد کن." };
  if ((Date.now() - (u.created || 0)) / 864e5 < MIN_ACCOUNT_DAYS) return { error: "حساب باید حداقل " + MIN_ACCOUNT_DAYS + " روز قدمت داشته باشد." };
  if ((u.rounds || 0) < MIN_ROUNDS) return { error: "حداقل " + MIN_ROUNDS + " دور بازی لازم است." };
  if ((u.reqs || []).some((r) => r.status === "pending")) return { error: "یک درخواست در انتظار داری." };
  const toman = pts / 1000 * POINT_TOMAN_PER_1000, wk = weekId();
  u.weekToman = u.weekToman || {}; if ((u.weekToman[wk] || 0) + toman > MAX_USER_WEEK_TOMAN) return { error: "سقف برداشت هفتگی تو پر می‌شود." };
  if (used + toman > WEEKLY_BUDGET) return { error: "بودجه‌ی پرداخت این هفته تمام شده. هفته‌ی بعد دوباره امتحان کن." };
  u.points -= pts; u.weekToman[wk] = (u.weekToman[wk] || 0) + toman; db.meta.paid[wk] = used + toman;
  const r = { id: crypto.randomBytes(4).toString("hex"), user: name, display: u.display, points: pts, toman, contact, status: "pending", ts: Date.now(), week: wk };
  db.requests.push(r); u.reqs = u.reqs || []; u.reqs.push({ id: r.id, points: pts, toman, status: "pending", ts: r.ts }); save();
  return { points: u.points, request: { id: r.id, toman } };
}

const adminOK = (url) => ADMIN_KEY && url.searchParams.get("key") === ADMIN_KEY;
const routes = {
  "POST /api/register": async (req, res) => {
    const ip = req.socket.remoteAddress, now = Date.now();
    regLog[ip] = (regLog[ip] || []).filter((t) => now - t < 36e5); if (regLog[ip].length >= 5) return send(res, 429, { error: "تعداد ثبت‌نام از این شبکه زیاد است. بعداً امتحان کن." });
    const { username, password, ref } = await body(req);
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username || "")) return send(res, 400, { error: "نام کاربری ۳ تا ۱۶ حرف انگلیسی، عدد یا _ باشد." });
    if (typeof password !== "string" || password.length < 6) return send(res, 400, { error: "رمز حداقل ۶ کاراکتر باشد." });
    const key = username.toLowerCase(); if (db.users[key]) return send(res, 409, { error: "این نام کاربری گرفته شده." });
    const salt = crypto.randomBytes(16).toString("hex");
    const u = { salt, hash: hash(password, salt), coins: START_COINS, weekNet: 0, week: weekId(), day: today(), adsToday: 0, todayRounds: 0, lastAd: 0, points: 0, rounds: 0, created: now,
      refCode: crypto.randomBytes(3).toString("hex"), refCount: 0, display: username };
    if (ref) { const rn = Object.keys(db.users).find((n) => db.users[n].refCode === String(ref).trim()); if (rn && db.users[rn].refCount < REF_CAP) { u.coins += REF_BONUS; u.refBy = rn; db.users[rn].coins += REF_BONUS; db.users[rn].refCount++; } }
    db.users[key] = u; regLog[ip].push(now);
    const t = crypto.randomBytes(24).toString("hex"); db.sessions[t] = key; save();
    send(res, 200, { token: t, user: pub(u) });
  },
  "POST /api/login": async (req, res) => {
    const { username, password } = await body(req); const key = String(username || "").toLowerCase(); const u = db.users[key];
    if (!u || hash(String(password || ""), u.salt) !== u.hash) return send(res, 401, { error: "نام کاربری یا رمز اشتباه است." });
    const t = crypto.randomBytes(24).toString("hex"); db.sessions[t] = key; refresh(u); save();
    send(res, 200, { token: t, user: pub(u) });
  },
  "GET /api/me": async (req, res) => { const a = auth(req); if (!a) return send(res, 401, { error: "وارد شو." }); send(res, 200, pub(a.u)); },

  "GET /api/crash/state": game((k) => E.roomState(k)),
  "POST /api/crash/bet": game((k, u, b) => E.roomBet(k, u, b.bet, b.auto)),
  "POST /api/crash/cancel": game((k, u) => E.roomCancel(k, u)),
  "POST /api/crash/cash": game((k, u) => E.roomCash(k, u)),
  "POST /api/pop/start": game((k, u, b) => E.popStart(k, u, b.bet)),
  "POST /api/pop/pump": game((k, u) => E.popPump(k, u)),
  "POST /api/pop/cash": game((k, u) => E.popCash(k, u)),
  "POST /api/mines/start": game((k, u, b) => E.minesStart(k, u, b.bet, b.k)),
  "POST /api/mines/reveal": game((k, u, b) => E.minesReveal(k, u, b.idx)),
  "POST /api/mines/cash": game((k, u) => E.minesCash(k, u)),
  "POST /api/rps": game((k, u, b) => E.rpsPlay(k, u, b.bet, b.choice)),
  "POST /api/rps/queue": game((k, u, b) => E.rpsQueue(k, u, b.bet)),
  "POST /api/rps/cancel": game((k, u) => E.rpsCancelQueue(k, u)),
  "POST /api/rps/choose": game((k, u, b) => E.rpsChoose(k, u, b.choice)),
  "GET /api/rps/status": game((k, u) => E.rpsStatus(k, u)),

  "POST /api/reward-ad": async (req, res) => {          // NOTE: verify ad completion with your ad network's server callback before opening the shop
    const a = auth(req); if (!a) return send(res, 401, { error: "وارد شو." }); const u = a.u, now = Date.now();
    if (u.adsToday >= AD_DAILY_CAP) return send(res, 429, { error: "سقف پاداش تبلیغ امروز تمام شد." });
    if (now - u.lastAd < AD_COOLDOWN_MS) return send(res, 429, { error: "کمی بعد دوباره امتحان کن." });
    u.adsToday++; u.lastAd = now; u.coins += AD_REWARD; u.points = (u.points || 0) + AD_POINTS; save();
    send(res, 200, { coins: u.coins, points: u.points, adsLeft: AD_DAILY_CAP - u.adsToday });
  },
  "GET /api/shop/info": game((k, u) => shopInfo(u)),
  "POST /api/shop/redeem": game((k, u, b) => redeem(k, u, b)),
  "GET /api/feed": async (req, res) => {
    const online = Object.values(db.users).filter((u) => Date.now() - (u.seen || 0) < 300000).length;
    send(res, 200, { online, feed });
  },
  "GET /api/leaderboard": async (req, res) => {
    const list = Object.values(db.users).filter((u) => u.week === weekId()).sort((x, y) => y.weekNet - x.weekNet).slice(0, 20).map((u) => ({ username: u.display, score: u.weekNet }));
    send(res, 200, { week: weekId(), top: list });
  },
  "GET /api/admin/top": async (req, res, url) => {
    if (!adminOK(url)) return send(res, 403, { error: "forbidden" });
    const list = Object.values(db.users).filter((u) => u.week === weekId()).sort((x, y) => y.weekNet - x.weekNet).slice(0, 3).map((u) => ({ username: u.display, score: u.weekNet }));
    send(res, 200, { week: weekId(), winners: list });
  },
  "GET /api/admin/requests": async (req, res, url) => {
    if (!adminOK(url)) return send(res, 403, { error: "forbidden" });
    send(res, 200, { budget: WEEKLY_BUDGET, reserved: db.meta.paid[weekId()] || 0, pending: db.requests.filter((r) => r.status === "pending") });
  },
  "POST /api/admin/resolve": async (req, res, url) => {          // body: {id, action: "paid" | "rejected"}
    if (!adminOK(url)) return send(res, 403, { error: "forbidden" });
    const { id, action } = await body(req); const r = db.requests.find((x) => x.id === id && x.status === "pending");
    if (!r || !["paid", "rejected"].includes(action)) return send(res, 400, { error: "درخواست نامعتبر" });
    r.status = action; const u = db.users[r.user];
    if (u) { const q = (u.reqs || []).find((x) => x.id === id); if (q) q.status = action; }
    if (action === "rejected" && u) { u.points = (u.points || 0) + r.points; db.meta.paid[r.week] = Math.max(0, (db.meta.paid[r.week] || 0) - r.toman); if (u.weekToman) u.weekToman[r.week] = Math.max(0, (u.weekToman[r.week] || 0) - r.toman); }
    save(); send(res, 200, { ok: true });
  },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); const h = routes[req.method + " " + url.pathname];
  if (h) { try { return await h(req, res, url); } catch (e) { return send(res, 500, { error: "خطای سرور" }); } }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html"))); }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("Arena running on port " + PORT));
