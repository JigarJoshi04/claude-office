// Stickers: the little things agents leave for the CEO in gift boxes. Each is 12×12 pixel art in one shared palette;
// drawn with a white die-cut edge and a soft shadow, so it reads as a sticker. Four rarities, weighted.
const PAL = {
  k: "#1a1c2b", w: "#ffffff", y: "#ffd24a", o: "#ff8f3d", r: "#e8475a", R: "#a32a3a", p: "#ff7ac8", g: "#4fc36a",
  G: "#2f8a48", b: "#4f86c0", B: "#2a4f7a", c: "#7fdbe6", v: "#9b6bff", V: "#6a3fc9", n: "#b07a4a", N: "#5e3b24",
  s: "#c9cdd8", S: "#7d8496", t: "#f2d5b0", d: "#e0b84a", D: "#9a7426", h: "#fff6c8",
};

export const RARITY = {
  common: { name: "Common", weight: 62, color: "#9aa3b8" },
  rare: { name: "Rare", weight: 27, color: "#4f9cf0" },
  epic: { name: "Epic", weight: 9, color: "#a77bff" },
  legendary: { name: "Legendary", weight: 2, color: "#ffc94a" },
  seasonal: { name: "Seasonal", weight: 0, color: "#ff8f3d" },     // never by weight: only in its season (rollSticker)
};

const DUCK = [
  "............",
  "....yyyy....",
  "...yyyyyy...",
  "...yykyyyoo.",
  "...yyyyyyoo.",
  "....yyyyy...",
  ".y..yyyy....",
  ".yyyyyyyyy..",
  ".yyyywyyyyy.",
  "..yyyyyyyy..",
  "...yyyyyy...",
  "............",
];

export const STICKERS = [
  { id: "duck", name: "Rubber duck", rarity: "common", art: DUCK },
  { id: "mug", name: "Coffee mug", rarity: "common", art: [
    "....S.S.....",
    "...S.S......",
    "............",
    ".rrrrrrrr...",
    ".rNNNNNNr...",
    ".rrrrrrrrrr.",
    ".rwrrrrrr.r.",
    ".rwrrrrrr.r.",
    ".rrrrrrrrrr.",
    ".rrrrrrrr...",
    "..RRRRRR....",
    "............"] },
  { id: "cactus", name: "Desk cactus", rarity: "common", art: [
    ".....gg.....",
    "....gggg....",
    "..g.gGgg....",
    "..g.gggg.g..",
    "..gggGgg.g..",
    "....gggggg..",
    "....gGgg....",
    "....gggg....",
    "..oooooooo..",
    "...oooooo...",
    "...oooooo...",
    "....oooo...."] },
  { id: "note", name: "Sticky note", rarity: "common", art: [
    "............",
    ".yyyyyyyyyy.",
    ".yyyyyyyyyy.",
    ".ykkkkkkyyy.",
    ".yyyyyyyyyy.",
    ".ykkkkkkkky.",
    ".yyyyyyyyyy.",
    ".ykkkkkyyyy.",
    ".yyyyyyyyDD.",
    ".yyyyyyyDD..",
    ".DDDDDDDD...",
    "............"] },
  { id: "floppy", name: "Floppy disk", rarity: "common", art: [
    "............",
    ".BBBBBBBBBB.",
    ".BBsssssBBB.",
    ".BBsssBsBBB.",
    ".BBsssssBBB.",
    ".BBBBBBBBBB.",
    ".BwwwwwwwwB.",
    ".BwkkkkkkwB.",
    ".BwwwwwwwwB.",
    ".BwkkkkwwwB.",
    ".BBBBBBBBBB.",
    "............"] },
  { id: "cookie", name: "Cookie", rarity: "common", art: [
    "............",
    "....tttt....",
    "..tttttttt..",
    ".ttNttttNtt.",
    ".tttttttttt.",
    ".ttttNttttt.",
    ".tNttttttNt.",
    ".tttttttNtt.",
    ".tttNtttttt.",
    "..tttttttt..",
    "....tttt....",
    "............"] },
  { id: "pizza", name: "Pizza slice", rarity: "common", art: [
    "............",
    ".nnnnnnnnnn.",
    ".NNNNNNNNNN.",
    "..yyryyyyy..",
    "..yyyyyryy..",
    "...yryyyy...",
    "...yyyyyy...",
    "....yyry....",
    "....yyyy....",
    ".....yy.....",
    ".....y......",
    "............"] },
  { id: "donut", name: "Donut", rarity: "common", art: [
    "............",
    "....pppp....",
    "..ppwpppyp..",
    ".pppppppppp.",
    ".pyppppwppp.",
    ".ppp....ppp.",
    ".ppp....ppp.",
    ".tpppppppyt.",
    ".ttppwppptt.",
    "..tttttttt..",
    "....tttt....",
    "............"] },
  { id: "plane", name: "Paper plane", rarity: "common", art: [
    "............",
    "..........ww",
    "........wwws",
    "......wwwwss",
    "....wwwwwss.",
    "..wwwwwwsS..",
    "wwwwwwwsS...",
    "..SSwwsS....",
    "....SwsS....",
    ".....SS.....",
    "......S.....",
    "............"] },
  { id: "pencil", name: "Pencil", rarity: "common", art: [
    "..........pp",
    ".........ppp",
    "........sss.",
    ".......yyo..",
    "......yyo...",
    ".....yyo....",
    "....yyo.....",
    "...yyo......",
    "..tto.......",
    ".ttt........",
    ".kt.........",
    "............"] },
  { id: "bug", name: "Squashed bug", rarity: "common", art: [
    "..k......k..",
    "...k....k...",
    "....kkkk....",
    "...kkkkkk...",
    "k.kggGGggk.k",
    ".kgggGGgggk.",
    "k.kggGGggk.k",
    ".kgggGGgggk.",
    "k.kggGGggk.k",
    "...kggggk...",
    "....kkkk....",
    "............"] },
  { id: "keycap", name: "Escape key", rarity: "common", art: [
    "............",
    ".SSSSSSSSSS.",
    ".Sssssssssk.",
    ".Swwwwwwwsk.",
    ".Swkkwkkwsk.",
    ".Swkwwkwwsk.",
    ".Swkkwkkwsk.",
    ".Swkwwwkwsk.",
    ".Swkkwkkwsk.",
    ".Swwwwwwwsk.",
    ".Skkkkkkkkk.",
    "............"] },
  { id: "rocket", name: "Rocket", rarity: "rare", art: [
    ".....rr.....",
    "....rwwr....",
    "....wwww....",
    "...wwbbww...",
    "...wbccbw...",
    "...wwbbww...",
    "...wwwwww...",
    "..rwwwwwwr..",
    ".rrwwwwwwrr.",
    ".rr.oyyo.rr.",
    ".....oo.....",
    "......o....."] },
  { id: "phones", name: "Headphones", rarity: "rare", art: [
    "............",
    "...kkkkkk...",
    "..kSSSSSSk..",
    ".kS......Sk.",
    ".kS......Sk.",
    ".kS......Sk.",
    "vvv......vvv",
    "vVv......vVv",
    "vVv......vVv",
    "vvv......vvv",
    ".v........v.",
    "............"] },
  { id: "lava", name: "Lava lamp", rarity: "rare", art: [
    ".....SS.....",
    "....SSSS....",
    "....vppv....",
    "...vvvpvv...",
    "...vpvvvv...",
    "...vvvppv...",
    "...vppvvv...",
    "...vvvvvv...",
    "....SSSS....",
    "...SSSSSS...",
    "..SSSSSSSS..",
    "............"] },
  { id: "gamepad", name: "Gamepad", rarity: "rare", art: [
    "............",
    "............",
    "..SSSSSSSS..",
    ".SSSSSSSSSS.",
    "SSkSSSSSrSSS",
    "SkkkSSSbSgSS",
    "SSkSSSSSySSS",
    "SSSSSSSSSSSS",
    "SSSS....SSSS",
    ".SS......SS.",
    "............",
    "............"] },
  { id: "robot", name: "Toy robot", rarity: "rare", art: [
    ".....r......",
    ".....k......",
    "..ssssssss..",
    "..swckswck..",
    "..ssssssss..",
    "..sskkkkss..",
    "...ssssss...",
    ".SssbbbbssS.",
    ".SssbybbssS.",
    "...ssssss...",
    "...ss..ss...",
    "..SSS..SSS.."] },
  { id: "compass", name: "Compass", rarity: "rare", art: [
    "............",
    "....dddd....",
    "..ddhhhhdd..",
    ".dhhhrhhhhd.",
    ".dhhhrrhhhd.",
    "dhhhhrrhhhhd",
    "dhhhhSShhhhd",
    ".dhhhSShhhd.",
    ".dhhhhShhhd.",
    "..ddhhhhdd..",
    "....dddd....",
    "............"] },
  { id: "coolduck", name: "Cool duck", rarity: "rare", art: [
    "............",
    "....yyyy....",
    "...yyyyyy...",
    "..kkkkkkyoo.",
    "...kkyyyyoo.",
    "....yyyyy...",
    ".y..yyyy....",
    ".yyyyyyyyy..",
    ".yyyywyyyyy.",
    "..yyyyyyyy..",
    "...yyyyyy...",
    "............"] },
  { id: "trophy", name: "Trophy", rarity: "epic", art: [
    "............",
    ".dddddddddd.",
    "dddhdddddddd",
    "d.dhddddd.dd",
    "d.dhdddddd.d",
    ".ddhddddddd.",
    "...ddddddd..",
    ".....dd.....",
    ".....dd.....",
    "....DDDD....",
    "...DDDDDD...",
    "............"] },
  { id: "gem", name: "Diamond", rarity: "epic", art: [
    "............",
    "...cccccc...",
    "..cwcccccc..",
    ".cwcccbcccc.",
    "cccccbbccccc",
    ".ccccbbcccb.",
    "..cccbbccb..",
    "...ccbbcb...",
    "....cbbb....",
    ".....cb.....",
    "............",
    "............"] },
  { id: "crown", name: "Crown", rarity: "epic", art: [
    "............",
    "............",
    "d....d....d.",
    "dd..ddd..dd.",
    "ddd.drd.ddd.",
    "ddddddddddd.",
    "dhdddddddhd.",
    "dddbdddrddd.",
    "ddddddddddd.",
    "DDDDDDDDDDD.",
    "............",
    "............"] },
  { id: "ufo", name: "UFO", rarity: "epic", art: [
    "............",
    "....cccc....",
    "...cwcccc...",
    "...cgkgkc...",
    "..ssssssss..",
    ".ssSSSSSSss.",
    "ssyssyssyssS",
    ".SSSSSSSSSS.",
    "...c.cc.c...",
    "..c..cc..c..",
    ".c...cc...c.",
    "............"] },
  { id: "pumpkin", name: "Pumpkin", rarity: "seasonal", season: "halloween", art: [
    "............",
    ".....GG.....",
    "......G.....",
    "..oooooooo..",
    ".oooooooooo.",
    ".ooyoooyooo.",
    ".oooooooooo.",
    ".ooyyyyyyoo.",
    ".oooyoyoooo.",
    "..oooooooo..",
    "...oooooo...",
    "............"] },
  { id: "diya", name: "Diya", rarity: "seasonal", season: "diwali", art: [
    "............",
    ".....o......",
    "....oyo.....",
    "....yhy.....",
    ".....y......",
    "..r......r..",
    ".rrrrrrrrrr.",
    ".rddddddddr.",
    "..rrrrrrrr..",
    "...RRRRRR...",
    "............",
    "............"] },
  { id: "snowflake", name: "Snowflake", rarity: "seasonal", season: "winter", art: [
    "............",
    ".....c......",
    "..c..c..c...",
    "...c.c.c....",
    "....ccc.....",
    ".ccccwcccc..",
    "....ccc.....",
    "...c.c.c....",
    "..c..c..c...",
    ".....c......",
    "............",
    "............"] },
  { id: "firework", name: "Firework", rarity: "seasonal", season: "winter", art: [
    "............",
    "..y..r..y...",
    "...y.r.y....",
    "....yry.....",
    ".rrrrhrrrr..",
    "....yry.....",
    "...y.r.y....",
    "..y..r..y...",
    "............",
    "......v.....",
    "......v.....",
    "......V....."] },
  { id: "goldduck", name: "Golden duck", rarity: "legendary", art: DUCK, gold: true },
];

const GOLD = { y: "#ffcf3a", w: "#fff6c8", k: "#5e3b24", o: "#e09a2a" };

// Draw a sticker at (x, y) with each art pixel `scale` px square: (rows + 3) × scale square with the die-cut edge and shadow.
export function drawSticker(ctx, st, x, y, scale = 3, opts = {}) {
  const art = st.art, n = art.length, fill = (c) => (st.gold && GOLD[c]) || PAL[c];
  const on = (i, j) => i >= 0 && j >= 0 && i < n && j < art[i].length && art[i][j] !== ".";
  const px = (j, i, c) => { ctx.fillStyle = c; ctx.fillRect(x + (j + 1) * scale, y + (i + 1) * scale, scale, scale); };
  const edge = (i, j) => !on(i, j) && [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]].some(([a, b]) => on(i + a, j + b));
  const cut = (i, j) => on(i, j) || edge(i, j);
  if (!opts.silhouette) for (let i = -1; i <= n + 1; i++) for (let j = -1; j <= n + 1; j++) if (!cut(i, j) && cut(i - 1, j - 1)) px(j, i, "rgba(0,0,0,0.22)");   // a soft drop shadow
  for (let i = -1; i <= n; i++) for (let j = -1; j <= n; j++) if (edge(i, j)) px(j, i, opts.silhouette ? "rgba(255,255,255,0.06)" : "#ffffff");
  for (let i = 0; i < n; i++) for (let j = 0; j < art[i].length; j++) if (on(i, j)) px(j, i, opts.silhouette ? "rgba(0,0,0,0.38)" : fill(art[i][j]));
  if (st.gold && !opts.silhouette && opts.t != null) {   // a glint sweeps across the golden duck
    const k = Math.floor(opts.t / 90) % 40;
    for (let i = 0; i < n; i++) { const j = k - i; if (on(i, j)) px(j, i, "rgba(255,255,255,0.75)"); }
  }
}

// A canvas holding one sticker, sized for its scale; used by the album and the gift reveal.
export function stickerCanvas(st, scale = 3, opts = {}) {
  const c = document.createElement("canvas"), size = (st.art.length + 3) * scale;
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  drawSticker(ctx, st, 0, 0, scale, opts);
  return c;
}

// Placeholders in an HTML string, <i data-sticker="id|scale|sil">, become sticker canvases after render.
export function hydrateStickers(root) {
  root.querySelectorAll("i[data-sticker]").forEach(el => {
    const [id, scale, sil] = el.dataset.sticker.split("|"), st = STICKERS.find(s => s.id === id);
    if (st) el.replaceWith(stickerCanvas(st, +scale || 3, { silhouette: sil === "sil", t: 900 }));
  });
}

// Pick a sticker: a rarity by weight, then one sticker of it. rand is a function returning [0, 1). In a season
// (engine/season.js) one gift in five is that season's sticker instead; they come back every year.
export function rollSticker(rand = Math.random, season = null) {
  const inSeason = season ? STICKERS.filter(s => s.season === season) : [];
  if (inSeason.length && rand() < 0.2) return inSeason[Math.min(inSeason.length - 1, Math.floor(rand() * inSeason.length))];
  const total = Object.values(RARITY).reduce((a, r) => a + r.weight, 0);
  let roll = rand() * total, rarity = "common";
  for (const [k, r] of Object.entries(RARITY)) { if (roll < r.weight) { rarity = k; break; } roll -= r.weight; }
  const pool = STICKERS.filter(s => s.rarity === rarity);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}
