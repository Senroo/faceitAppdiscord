const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require("discord.js");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ─── Persistent JSON files ───────────────────────────────────────────────────
// Use /data volume on Railway, fallback to local dir
const DATA_DIR = fs.existsSync("/data") ? "/data" : ".";
const CONFIG_FILE      = `${DATA_DIR}/config.json`;
const SEEN_FILE        = `${DATA_DIR}/seen_matches.json`;
const HISTORY_FILE     = `${DATA_DIR}/match_history.json`;
const ELO_HISTORY_FILE = `${DATA_DIR}/elo_history.json`;
const LEVELS_FILE      = `${DATA_DIR}/player_levels.json`;

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let config = loadJSON(CONFIG_FILE, {
  faceitApiKey: "",
  discordWebhook: "",
  discordBotToken: "",
  discordGuildId: "",
  players: [],
  pollIntervalSeconds: 60,
  active: false,
});

// Override with environment variables if present (Railway deployment)
if (process.env.FACEIT_API_KEY)    config.faceitApiKey    = process.env.FACEIT_API_KEY;
if (process.env.DISCORD_WEBHOOK)   config.discordWebhook  = process.env.DISCORD_WEBHOOK;
if (process.env.DISCORD_BOT_TOKEN) config.discordBotToken = process.env.DISCORD_BOT_TOKEN;
if (process.env.DISCORD_GUILD_ID)  config.discordGuildId  = process.env.DISCORD_GUILD_ID;
if (process.env.PLAYERS) {
  try { config.players = JSON.parse(process.env.PLAYERS); } catch {}
}
if (process.env.POLL_INTERVAL)     config.pollIntervalSeconds = parseInt(process.env.POLL_INTERVAL);
if (process.env.ACTIVE === "true") config.active = true;

let seenMatches   = loadJSON(SEEN_FILE, {});
let matchHistory  = loadJSON(HISTORY_FILE, {});    // { playerId: [ matchRecord, ... ] }
let eloHistory    = loadJSON(ELO_HISTORY_FILE, {}); // { playerId: [ { elo, ts }, ... ] }
let playerLevels  = loadJSON(LEVELS_FILE, {});      // { playerId: level }

let pollingTimer  = null;
let logs          = [];
let discordClient = null;

// ─── Logging ─────────────────────────────────────────────────────────────────
function addLog(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 150) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Faceit API ───────────────────────────────────────────────────────────────
const FACEIT = axios.create({
  baseURL: "https://open.faceit.com/data/v4",
  headers: { Authorization: `Bearer ${config.faceitApiKey}` },
});
function refreshFaceitAuth() {
  FACEIT.defaults.headers["Authorization"] = `Bearer ${config.faceitApiKey}`;
}

async function getPlayerId(nickname) {
  refreshFaceitAuth();
  const res = await FACEIT.get("/players", { params: { nickname } });
  return {
    id: res.data.player_id,
    nickname: res.data.nickname,
    avatar: res.data.avatar || "",
    country: res.data.country || "",
  };
}

async function getPlayerProfile(playerId) {
  try {
    refreshFaceitAuth();
    const res = await FACEIT.get(`/players/${playerId}`);
    return res.data;
  } catch { return null; }
}

async function getPlayerLifetime(playerId) {
  refreshFaceitAuth();
  for (const game of ["cs2", "csgo"]) {
    try {
      const res = await FACEIT.get(`/players/${playerId}/stats/${game}`);
      if (res.data?.lifetime) return res.data.lifetime;
    } catch {}
  }
  return null;
}

async function detectGame(playerId) {
  try {
    const profile = await getPlayerProfile(playerId);
    const games = profile?.games || {};
    // Log available game keys to help debug
    addLog(`Jeux détectés pour ${playerId}: ${Object.keys(games).join(', ') || 'aucun'}`, "info");
    if (games.cs2)  return "cs2";
    if (games.csgo) return "csgo";
    // Try first available game
    const first = Object.keys(games)[0];
    if (first) return first;
  } catch {}
  return "cs2";
}

async function getRecentMatches(playerId, limit = 10) {
  refreshFaceitAuth();

  // Debug: log the player profile games
  try {
    const profile = await getPlayerProfile(playerId);
    const games = profile?.games || {};
    addLog(`🔍 Profil jeux pour ${playerId}: ${JSON.stringify(Object.keys(games))}`, "info");
  } catch {}

  // Try every possible game ID
  for (const game of ["cs2", "csgo", "cs_go", "730"]) {
    try {
      const res = await FACEIT.get(`/players/${playerId}/history`, {
        params: { game, limit },
      });
      const items = res.data?.items;
      if (items && items.length > 0) {
        addLog(`✅ Historique OK pour ${playerId} avec game="${game}" (${items.length} matchs)`, "success");
        return items;
      }
    } catch (e) {
      addLog(`⚠️ game="${game}" → ${e.response?.status || e.message}`, "warn");
    }
  }

  // Last resort: try without game filter
  try {
    const res = await FACEIT.get(`/players/${playerId}/history`, { params: { limit } });
    const items = res.data?.items;
    addLog(`🔍 Sans filtre game: ${items?.length || 0} matchs`, "info");
    if (items?.length) return items;
  } catch (e) {
    addLog(`Sans filtre game → erreur: ${e.message}`, "warn");
  }

  return [];
}

async function getMatchDetails(matchId) {
  refreshFaceitAuth();
  const res = await FACEIT.get(`/matches/${matchId}`);
  return res.data;
}

async function getMatchStats(matchId) {
  try {
    refreshFaceitAuth();
    const res = await FACEIT.get(`/matches/${matchId}/stats`);
    return res.data;
  } catch { return null; }
}

// ─── Stats extraction ─────────────────────────────────────────────────────────
function extractPlayerStats(playerId, matchStats, matchDetails) {
  try {
    const teams = matchStats.rounds?.[0]?.teams || [];
    addLog(`🔍 extractPlayerStats: ${teams.length} équipes, cherche playerId=${playerId.substring(0,8)}`, "info");

    let playerData = null, playerTeam = null, opponentTeam = null;

    for (const team of teams) {
      const playerIds = (team.players || []).map(p => p.player_id);
      addLog(`🔍 Équipe players: ${playerIds.map(id => id.substring(0,8)).join(', ')}`, "info");
      const found = team.players?.find((p) => p.player_id === playerId);
      if (found) { playerData = found.player_stats; playerTeam = team; }
      else opponentTeam = team;
    }

    if (!playerData) {
      addLog(`⚠️ Joueur ${playerId.substring(0,8)} non trouvé dans le match`, "warn");
      return null;
    }

    const roundStats = matchStats.rounds?.[0]?.round_stats || {};
    const map = (roundStats["Map"] || matchDetails.voting?.map?.pick?.[0] || "Unknown")
      .replace("de_", "").toUpperCase();
    const score = roundStats["Score"] || "?:?";
    const result = playerTeam?.team_stats?.["Team Win"] === "1" ? "Win" : "Loss";

    return {
      result, map, score,
      kills:  playerData["Kills"]          || "0",
      deaths: playerData["Deaths"]         || "0",
      assists:playerData["Assists"]        || "0",
      kd:     playerData["K/D Ratio"]      || "0.00",
      hs:     playerData["Headshots %"]    || "0",
      mvps:   playerData["MVPs"]           || "0",
      adr:    playerData["ADR"]            || "0",
    };
  } catch (e) {
    addLog(`Erreur extraction stats: ${e.message}`, "error");
    return null;
  }
}

// ─── Backfill history for a player (fetch last 20 matches) ───────────────────
async function backfillPlayerHistory(player) {
  try {
    addLog(`🔄 Backfill historique pour ${player.nickname}...`, "info");
    const matches = await getRecentMatches(player.id, 20);
    addLog(`📦 ${player.nickname}: ${matches.length} matchs trouvés dans l'API (statuts: ${[...new Set(matches.map(m=>m.status))].join(', ')})`, "info");

    let added = 0;
    for (const match of matches) {
      // Accept any "finished" variant
      const status = (match.status || "").toLowerCase();
      if (status !== "finished") continue;
      if ((matchHistory[player.id] || []).find(m => m.matchId === match.match_id)) continue;

      const [details, mStats] = await Promise.all([
        getMatchDetails(match.match_id),
        getMatchStats(match.match_id),
      ]);
      if (mStats) {
        const rounds = mStats.rounds?.length || 0;
        const firstTeamPlayers = mStats.rounds?.[0]?.teams?.[0]?.players?.length || 0;
        addLog(`🔍 Match ${match.match_id.substring(0,8)}: ${rounds} rounds, ${firstTeamPlayers} joueurs équipe 1`, "info");
        const stats = extractPlayerStats(player.id, mStats, details);
        if (stats) {
          const ts = match.finished_at ? match.finished_at * 1000 : Date.now();
          storeMatchHistory(player.id, match.match_id, stats, ts);
          added++;
        } else {
          addLog(`⚠️ Stats nulles pour match ${match.match_id.substring(0,8)}`, "warn");
        }
      } else {
        addLog(`⚠️ mStats null pour match ${match.match_id.substring(0,8)}`, "warn");
      }
      if (!seenMatches[player.id]) seenMatches[player.id] = [];
      if (!seenMatches[player.id].includes(match.match_id)) {
        seenMatches[player.id].unshift(match.match_id);
      }
    }
    seenMatches[player.id] = (seenMatches[player.id] || []).slice(0, 50);
    saveJSON(SEEN_FILE, seenMatches);
    addLog(`✅ Backfill ${player.nickname}: ${added} match(s) importés`, "success");
  } catch (e) {
    addLog(`Erreur backfill ${player.nickname}: ${e.message}`, "error");
  }
}

async function backfillAll() {
  for (const player of config.players) {
    // Backfill if less than 5 matches in history
    if (!matchHistory[player.id] || matchHistory[player.id].length < 5) {
      // Reset seen so backfill can re-process
      delete matchHistory[player.id];
      saveJSON(HISTORY_FILE, matchHistory);
      await backfillPlayerHistory(player);
    }
  }
}

function snapshotElo(playerId, elo) {
  if (!eloHistory[playerId]) eloHistory[playerId] = [];
  const last = eloHistory[playerId][0];
  // Only record if ELO changed or no snapshot yet
  if (!last || last.elo !== elo) {
    eloHistory[playerId].unshift({ elo, ts: Date.now() });
    eloHistory[playerId] = eloHistory[playerId].slice(0, 200); // keep 200 snapshots
    saveJSON(ELO_HISTORY_FILE, eloHistory);
  }
}

// ─── Match history storage ────────────────────────────────────────────────────
function storeMatchHistory(playerId, matchId, stats, ts) {
  if (!matchHistory[playerId]) matchHistory[playerId] = [];
  if (matchHistory[playerId].find(m => m.matchId === matchId)) return;
  matchHistory[playerId].unshift({ matchId, ts, ...stats });
  matchHistory[playerId] = matchHistory[playerId].slice(0, 50);
  saveJSON(HISTORY_FILE, matchHistory);
}

// ─── Level change detection ───────────────────────────────────────────────────
async function checkLevelChange(player, newLevel) {
  const oldLevel = playerLevels[player.id];
  if (oldLevel === undefined) {
    playerLevels[player.id] = newLevel;
    saveJSON(LEVELS_FILE, playerLevels);
    return;
  }
  if (newLevel === oldLevel) return;

  const went_up = newLevel > oldLevel;
  playerLevels[player.id] = newLevel;
  saveJSON(LEVELS_FILE, playerLevels);

  const LEVEL_COLORS = [0,0xffffff,0x1ddc17,0x1ddc17,0xff9c17,0xff9c17,0xff9c17,0xff1717,0xff1717,0xff1717,0xaa00ff];
  const emoji = went_up ? "⬆️" : "⬇️";
  const title = went_up
    ? `${emoji} ${player.nickname} est passé niveau ${newLevel} !`
    : `${emoji} ${player.nickname} est descendu niveau ${newLevel}`;

  addLog(`${emoji} Changement de niveau pour ${player.nickname}: ${oldLevel} → ${newLevel}`, went_up ? "success" : "warn");

  if (config.discordWebhook) {
    await axios.post(config.discordWebhook, {
      username: "Faceit Tracker",
      avatar_url: "https://cdn-frontend.faceit-cdn.net/web/static/media/faceit_logo_256.png",
      embeds: [{
        title,
        description: `Niveau **${oldLevel}** → Niveau **${newLevel}**`,
        color: LEVEL_COLORS[newLevel] || 0xff5500,
        thumbnail: { url: player.avatar || "" },
        footer: { text: "Faceit Tracker" },
        timestamp: new Date().toISOString(),
      }]
    });
  }
}

// ─── Discord match notification ───────────────────────────────────────────────
async function sendMatchNotification(player, matchId, stats) {
  if (!config.discordWebhook) return;
  const { result, map, score, kills, deaths, assists, kd, hs, mvps, adr } = stats;
  const color   = result === "Win" ? 0x00d26a : 0xff4655;
  const emoji   = result === "Win" ? "🟢" : "🔴";

  await axios.post(config.discordWebhook, {
    username: "Faceit Tracker",
    avatar_url: "https://cdn-frontend.faceit-cdn.net/web/static/media/faceit_logo_256.png",
    embeds: [{
      title: `${emoji} ${player.nickname} — ${result}`,
      color,
      thumbnail: { url: player.avatar || "" },
      fields: [
        { name: "🗺️ Map",        value: `\`${map}\``,                    inline: true },
        { name: "🏆 Score",      value: `\`${score}\``,                  inline: true },
        { name: "⚔️ K/D/A",     value: `\`${kills}/${deaths}/${assists}\``, inline: true },
        { name: "📊 K/D",        value: `\`${kd}\``,                     inline: true },
        { name: "🎯 HS%",        value: `\`${hs}%\``,                    inline: true },
        { name: "💥 ADR",        value: `\`${adr}\``,                    inline: true },
        { name: "⭐ MVPs",       value: `\`${mvps}\``,                   inline: true },
        { name: "🔗 Match",      value: `[Faceit](https://www.faceit.com/en/cs2/room/${matchId})`, inline: true },
      ],
      footer: { text: `Faceit Tracker • ${player.nickname}` },
      timestamp: new Date().toISOString(),
    }]
  });
  addLog(`✅ Notif Discord: ${player.nickname} — ${result} sur ${map}`, "success");
}

// ─── Leaderboard builder ──────────────────────────────────────────────────────
async function buildLeaderboard() {
  refreshFaceitAuth();
  const results = [];
  for (const player of config.players) {
    try {
      const [profile, lifetime] = await Promise.all([
        getPlayerProfile(player.id),
        getPlayerLifetime(player.id),
      ]);
      const cs2 = profile?.games?.cs2?.faceit_elo
        ? profile.games.cs2
        : (profile?.games?.csgo || {});
      const elo   = cs2.faceit_elo   || 0;
      const level = cs2.skill_level  || 0;
      snapshotElo(player.id, elo);
      await checkLevelChange(player, level);
      results.push({
        id: player.id, nickname: player.nickname,
        avatar: player.avatar || "", country: player.country || "",
        elo, level,
        kd:            parseFloat(lifetime?.["Average K/D Ratio"]    || 0),
        hs:            parseFloat(lifetime?.["Average Headshots %"]   || 0),
        winRate:       parseFloat(lifetime?.["Win Rate %"]            || 0),
        matches:       parseInt(lifetime?.["Matches"]                 || 0),
        longestStreak: parseInt(lifetime?.["Longest Win Streak"]      || 0),
        recentResults: lifetime?.["Recent Results"] || [],
      });
    } catch (e) {
      addLog(`Erreur leaderboard ${player.nickname}: ${e.message}`, "warn");
    }
  }
  results.sort((a, b) => b.elo - a.elo);
  return results;
}

let leaderboardCache = { data: null, ts: 0 };
async function getCachedLeaderboard(force = false) {
  if (!force && leaderboardCache.data && Date.now() - leaderboardCache.ts < 120_000) {
    return leaderboardCache.data;
  }
  const data = await buildLeaderboard();
  leaderboardCache = { data, ts: Date.now() };
  return data;
}

// ─── Core polling ─────────────────────────────────────────────────────────────
async function checkPlayerMatches(player) {
  try {
    const matches = await getRecentMatches(player.id, 5);
    const key = player.id;

    if (!seenMatches[key]) {
      seenMatches[key] = matches.map((m) => m.match_id);
      saveJSON(SEEN_FILE, seenMatches);
      addLog(`Init: ${matches.length} matchs pour ${player.nickname}`, "info");
      return;
    }

    const newMatches = matches.filter(
      (m) => !seenMatches[key].includes(m.match_id) && (m.status || "").toLowerCase() === "finished"
    );

    for (const match of newMatches) {
      addLog(`🆕 Nouveau match: ${player.nickname} (${match.match_id})`, "info");
      const [details, mStats] = await Promise.all([
        getMatchDetails(match.match_id),
        getMatchStats(match.match_id),
      ]);
      if (mStats) {
        const stats = extractPlayerStats(player.id, mStats, details);
        if (stats) {
          const ts = match.finished_at ? match.finished_at * 1000 : Date.now();
          storeMatchHistory(player.id, match.match_id, stats, ts);
          await sendMatchNotification(player, match.match_id, stats);
        }
      }
      seenMatches[key].unshift(match.match_id);
    }

    seenMatches[key] = seenMatches[key].slice(0, 50);
    saveJSON(SEEN_FILE, seenMatches);
  } catch (e) {
    addLog(`Erreur polling ${player.nickname}: ${e.message}`, "error");
  }
}

async function pollAllPlayers() {
  if (!config.active || !config.players.length) return;
  addLog(`🔄 Vérification (${config.players.length} joueur(s))...`, "info");
  for (const p of config.players) await checkPlayerMatches(p);
}

function startPolling() {
  stopPolling();
  const iv = (config.pollIntervalSeconds || 60) * 1000;
  pollingTimer = setInterval(pollAllPlayers, iv);
  addLog(`▶️ Polling démarré (${config.pollIntervalSeconds}s)`, "success");
  pollAllPlayers();
}
function stopPolling() {
  if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

// ─── Discord Bot (slash commands) ─────────────────────────────────────────────
const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("classement")
    .setDescription("Affiche le classement ELO du groupe"),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Stats d'un joueur suivi")
    .addStringOption(o => o.setName("joueur").setDescription("Pseudo Faceit").setRequired(true)),

  new SlashCommandBuilder()
    .setName("historique")
    .setDescription("Derniers matchs d'un joueur")
    .addStringOption(o => o.setName("joueur").setDescription("Pseudo Faceit").setRequired(true)),
].map(c => c.toJSON());

async function registerSlashCommands(token, guildId, clientId) {
  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const route = guildId
      ? Routes.applicationGuildCommands(clientId, guildId)
      : Routes.applicationCommands(clientId);
    await rest.put(route, { body: SLASH_COMMANDS });
    addLog("✅ Slash commands enregistrées", "success");
  } catch (e) {
    addLog(`Erreur enregistrement slash commands: ${e.message}`, "error");
  }
}

function buildStatsEmbed(player, lb) {
  const p = lb.find(x => x.nickname.toLowerCase() === player.toLowerCase());
  if (!p) return null;
  const rank = lb.findIndex(x => x.id === p.id) + 1;
  const MEDALS = ["🥇","🥈","🥉"];
  const rankStr = MEDALS[rank-1] || `#${rank}`;
  const LEVEL_COLORS = [0,0xffffff,0x1ddc17,0x1ddc17,0xff9c17,0xff9c17,0xff9c17,0xff1717,0xff1717,0xff1717,0xaa00ff];
  const recent = (p.recentResults||[]).slice(0,5).map(r => r==="1"?"✅":"❌").join(" ");
  return new EmbedBuilder()
    .setTitle(`${rankStr} ${p.nickname} — Niveau ${p.level}`)
    .setColor(LEVEL_COLORS[p.level] || 0xff5500)
    .setThumbnail(p.avatar)
    .addFields(
      { name: "ELO",      value: `**${p.elo}**`,              inline: true },
      { name: "K/D",      value: `\`${p.kd.toFixed(2)}\``,    inline: true },
      { name: "HS%",      value: `\`${p.hs.toFixed(0)}%\``,   inline: true },
      { name: "Win Rate", value: `\`${p.winRate.toFixed(0)}%\``, inline: true },
      { name: "Matchs",   value: `\`${p.matches}\``,          inline: true },
      { name: "Streak",   value: `\`${p.longestStreak}\``,    inline: true },
      { name: "Récents",  value: recent || "N/A",              inline: false },
    )
    .setFooter({ text: "Faceit Tracker" })
    .setTimestamp();
}

function buildHistoryEmbed(playerNick, playerId) {
  const history = (matchHistory[playerId] || []).slice(0, 10);
  if (!history.length) return null;
  const lines = history.map(m => {
    const emoji = m.result === "Win" ? "🟢" : "🔴";
    const d = m.ts ? new Date(m.ts).toLocaleDateString("fr-FR") : "?";
    return `${emoji} **${m.map}** \`${m.score}\` · KDA: \`${m.kills}/${m.deaths}/${m.assists}\` · K/D: \`${m.kd}\` · ${d}`;
  }).join("\n");

  return new EmbedBuilder()
    .setTitle(`📅 Historique — ${playerNick}`)
    .setDescription(lines)
    .setColor(0xff5500)
    .setFooter({ text: "Faceit Tracker" })
    .setTimestamp();
}

async function startDiscordBot() {
  if (!config.discordBotToken) return;
  if (discordClient) { try { discordClient.destroy(); } catch {} }

  discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

  discordClient.once("ready", async () => {
    addLog(`🤖 Bot Discord connecté: ${discordClient.user.tag}`, "success");
    await registerSlashCommands(config.discordBotToken, config.discordGuildId, discordClient.user.id);
  });

  discordClient.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    try {
      if (commandName === "classement") {
        await interaction.deferReply();
        const lb = await getCachedLeaderboard();
        if (!lb.length) return interaction.editReply("Aucun joueur enregistré.");
        const MEDALS = ["🥇","🥈","🥉"];
        const LEVEL_COLORS = [0,0xffffff,0x1ddc17,0x1ddc17,0xff9c17,0xff9c17,0xff9c17,0xff1717,0xff1717,0xff1717,0xaa00ff];
        const rows = lb.map((p, i) => {
          const medal = MEDALS[i] || `**${i+1}.**`;
          const recent = (p.recentResults||[]).slice(0,5).map(r=>r==="1"?"✅":"❌").join("");
          return `${medal} **${p.nickname}** — ${p.elo} ELO (Lvl ${p.level})\n┗ K/D: \`${p.kd.toFixed(2)}\` · WR: \`${p.winRate.toFixed(0)}%\` · ${recent}`;
        }).join("\n\n");
        const embed = new EmbedBuilder()
          .setTitle("🏆 Classement Faceit — Groupe")
          .setDescription(rows)
          .setColor(LEVEL_COLORS[lb[0]?.level] || 0xff5500)
          .setThumbnail(lb[0]?.avatar || "")
          .setTimestamp()
          .setFooter({ text: "Faceit Tracker" });
        await interaction.editReply({ embeds: [embed] });

      } else if (commandName === "stats") {
        await interaction.deferReply();
        const nickname = interaction.options.getString("joueur");
        const lb = await getCachedLeaderboard();
        const embed = buildStatsEmbed(nickname, lb);
        if (!embed) return interaction.editReply(`Joueur "${nickname}" non trouvé dans le groupe.`);
        await interaction.editReply({ embeds: [embed] });

      } else if (commandName === "historique") {
        await interaction.deferReply();
        const nickname = interaction.options.getString("joueur").toLowerCase();
        const player = config.players.find(p => p.nickname.toLowerCase() === nickname);
        if (!player) return interaction.editReply(`Joueur "${nickname}" non trouvé.`);
        const embed = buildHistoryEmbed(player.nickname, player.id);
        if (!embed) return interaction.editReply(`Pas encore d'historique pour ${player.nickname}.`);
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (e) {
      addLog(`Erreur slash command: ${e.message}`, "error");
      try { interaction.editReply("❌ Erreur interne."); } catch {}
    }
  });

  try {
    await discordClient.login(config.discordBotToken);
  } catch (e) {
    addLog(`Erreur connexion bot Discord: ${e.message}`, "error");
    discordClient = null;
  }
}

// ─── REST API Routes ──────────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({
    ...config,
    faceitApiKey:    config.faceitApiKey    ? "***hidden***" : "",
    discordWebhook:  config.discordWebhook  ? "***hidden***" : "",
    discordBotToken: config.discordBotToken ? "***hidden***" : "",
  });
});

app.post("/api/config", async (req, res) => {
  const { faceitApiKey, discordWebhook, discordBotToken, discordGuildId, pollIntervalSeconds } = req.body;
  const botTokenChanged = discordBotToken && discordBotToken !== "***hidden***" && discordBotToken !== config.discordBotToken;

  if (faceitApiKey    && faceitApiKey    !== "***hidden***") config.faceitApiKey    = faceitApiKey;
  if (discordWebhook  && discordWebhook  !== "***hidden***") config.discordWebhook  = discordWebhook;
  if (discordBotToken && discordBotToken !== "***hidden***") config.discordBotToken = discordBotToken;
  if (discordGuildId  !== undefined) config.discordGuildId = discordGuildId;
  if (pollIntervalSeconds) config.pollIntervalSeconds = Math.max(30, parseInt(pollIntervalSeconds));
  saveJSON(CONFIG_FILE, config);

  if (botTokenChanged) await startDiscordBot();
  res.json({ ok: true });
});

app.post("/api/players/add", async (req, res) => {
  const { nickname } = req.body;
  if (!nickname)               return res.status(400).json({ error: "Nickname requis" });
  if (!config.faceitApiKey)    return res.status(400).json({ error: "Clé API Faceit manquante" });
  try {
    const info = await getPlayerId(nickname);
    if (config.players.find(p => p.id === info.id))
      return res.status(409).json({ error: "Joueur déjà suivi" });
    config.players.push(info);
    saveJSON(CONFIG_FILE, config);
    addLog(`➕ ${info.nickname} ajouté`, "success");
    // Backfill history immediately for new player
    backfillPlayerHistory(info).catch(() => {});
    res.json(info);
  } catch (e) {
    res.status(404).json({ error: `Introuvable: ${e.message}` });
  }
});

app.delete("/api/players/:id", (req, res) => {
  config.players = config.players.filter(p => p.id !== req.params.id);
  saveJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

app.post("/api/toggle", (req, res) => {
  if (!config.faceitApiKey)   return res.status(400).json({ error: "Clé API Faceit manquante" });
  if (!config.discordWebhook) return res.status(400).json({ error: "Webhook Discord manquant" });
  if (!config.players.length) return res.status(400).json({ error: "Aucun joueur suivi" });
  config.active = !config.active;
  saveJSON(CONFIG_FILE, config);
  if (config.active) startPolling(); else stopPolling();
  res.json({ active: config.active });
});

app.post("/api/test-webhook", async (req, res) => {
  if (!config.discordWebhook) return res.status(400).json({ error: "Webhook manquant" });
  try {
    await axios.post(config.discordWebhook, {
      username: "Faceit Tracker",
      avatar_url: "https://cdn-frontend.faceit-cdn.net/web/static/media/faceit_logo_256.png",
      embeds: [{ title: "✅ Test de connexion", description: "Webhook OK !", color: 0x00d26a, timestamp: new Date().toISOString() }]
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/leaderboard", async (req, res) => {
  if (!config.faceitApiKey)   return res.status(400).json({ error: "Clé API Faceit manquante" });
  if (!config.players.length) return res.json([]);
  try {
    const data = await getCachedLeaderboard(req.query.force === "1");
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/leaderboard/post-discord", async (req, res) => {
  if (!config.discordWebhook) return res.status(400).json({ error: "Webhook Discord manquant" });
  try {
    const lb = await getCachedLeaderboard(true);
    if (!lb.length) return res.status(400).json({ error: "Aucun joueur" });
    const MEDALS = ["🥇","🥈","🥉"];
    const LEVEL_COLORS = [0,0xffffff,0x1ddc17,0x1ddc17,0xff9c17,0xff9c17,0xff9c17,0xff1717,0xff1717,0xff1717,0xaa00ff];
    const rows = lb.map((p, i) => {
      const medal = MEDALS[i] || `**${i+1}.**`;
      const recent = (p.recentResults||[]).slice(0,5).map(r=>r==="1"?"✅":"❌").join("");
      return `${medal} **${p.nickname}** — ${p.elo} ELO (Lvl ${p.level})\n┣ K/D: \`${p.kd.toFixed(2)}\` · HS: \`${p.hs.toFixed(0)}%\` · WR: \`${p.winRate.toFixed(0)}%\`\n┗ Matchs: \`${p.matches}\` · ${recent}`;
    }).join("\n\n");
    await axios.post(config.discordWebhook, {
      username: "Faceit Tracker",
      avatar_url: "https://cdn-frontend.faceit-cdn.net/web/static/media/faceit_logo_256.png",
      embeds: [{
        title: "🏆 Classement Faceit — Groupe",
        description: rows,
        color: LEVEL_COLORS[lb[0]?.level] || 0xff5500,
        footer: { text: `Mis à jour le ${new Date().toLocaleString("fr-FR")}` },
        thumbnail: { url: lb[0]?.avatar || "" },
      }]
    });
    addLog("📊 Classement posté sur Discord", "success");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Force backfill for a specific player
app.post("/api/players/:id/backfill", async (req, res) => {
  const player = config.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: "Joueur introuvable" });
  backfillPlayerHistory(player).catch(() => {});
  res.json({ ok: true, msg: `Backfill lancé pour ${player.nickname}` });
});

app.get("/api/history/:playerId", (req, res) => {
  const history = matchHistory[req.params.playerId] || [];
  res.json(history);
});

// ELO history for a player
app.get("/api/elo-history/:playerId", (req, res) => {
  const history = eloHistory[req.params.playerId] || [];
  res.json(history);
});

app.get("/api/logs", (req, res) => res.json(logs));

app.get("/api/status", (req, res) => {
  res.json({
    active: config.active,
    playerCount: config.players.length,
    players: config.players,
    pollIntervalSeconds: config.pollIntervalSeconds,
    botConnected: !!discordClient?.isReady(),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🎮 Faceit Tracker v2`);
  console.log(`📡 Dashboard: http://localhost:${PORT}\n`);
  if (config.discordBotToken) await startDiscordBot();
  if (config.active && config.players.length) {
    addLog("🔄 Reprise du polling...", "info");
    startPolling();
  }
  // Backfill history for players that have none yet
  if (config.faceitApiKey && config.players.length) {
    setTimeout(() => backfillAll(), 3000);
  }
});