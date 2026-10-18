// The office levels up with everyone's work: its XP is the sum of every character's XP (office/career.py), and each
// office level unlocks something on the floor. The floor (office.js) draws what is unlocked; the inspector lists it.
export const OFFICE_STEP = 400;                       // office level n needs 400 · (n − 1)² XP
export const xpForOffice = (n) => OFFICE_STEP * (n - 1) ** 2;

export const UNLOCKS = [
  { level: 2, id: "palms", icon: "sparkles", name: "Lobby palms", desc: "Two tall palms welcome visitors at the elevator." },
  { level: 3, id: "roomba", icon: "bot", name: "Robot vacuum", desc: "A little vacuum keeps the corridors spotless." },
  { level: 4, id: "flowers", icon: "heart", name: "In bloom", desc: "Every room's plants burst into flower." },
  { level: 5, id: "drone", icon: "send", name: "Delivery drone", desc: "Parcels fly over the building now and then." },
  { level: 6, id: "goldlift", icon: "star", name: "Gold elevator", desc: "The elevator doors turn gold." },
  { level: 7, id: "posters", icon: "star", name: "Lounge posters", desc: "A rocket and a heart join the chart on the lounge wall." },
  { level: 8, id: "dog", icon: "heart", name: "Biscuit the dog", desc: "A dog joins Pixel the cat on the floor. Click him." },
  { level: 9, id: "stringlights", icon: "sparkles", name: "String lights", desc: "Fairy lights along the top of the lobby wall, twinkling at night." },
  { level: 10, id: "neon", icon: "zap", name: "Neon show", desc: "The office sign cycles through colours." },
  { level: 11, id: "roombas", icon: "bot", name: "A vacuum for every corridor", desc: "Every corridor gets its own robot vacuum." },
  { level: 12, id: "balloon", icon: "sun", name: "Hot-air balloon", desc: "A balloon drifts past the windows on sunny days." },
  { level: 13, id: "mats", icon: "users", name: "Welcome mats", desc: "A mat in each character's colour outside its door." },
  { level: 15, id: "fireworks", icon: "sparkles", name: "Fireworks", desc: "At night, fireworks light up the windows." },
  { level: 20, id: "goldplates", icon: "trophy", name: "Gold nameplates", desc: "Every door gets a gold nameplate." },
  { level: 25, id: "statue", icon: "star", name: "The founder's statue", desc: "A golden statue of you in the lobby." },
];

// The office's level from its seats: { level, xp, at (XP where this level began), next (XP for the next), progress 0–1,
// unlocked (Set of ids), upcoming (the next unlock or null) }.
export function officeLevel(seats) {
  const xp = (seats || []).reduce((a, s) => a + ((s.career && s.career.xp) || 0), 0);
  const level = Math.floor(Math.sqrt(xp / OFFICE_STEP)) + 1;
  const at = xpForOffice(level), next = xpForOffice(level + 1);
  const unlocked = new Set(UNLOCKS.filter(u => u.level <= level).map(u => u.id));
  return { level, xp, at, next, progress: (xp - at) / (next - at), unlocked, upcoming: UNLOCKS.find(u => u.level > level) || null };
}
