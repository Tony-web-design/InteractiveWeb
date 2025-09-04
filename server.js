const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

/** ====== 基本伺服器設定 ====== */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // 若部署到某些平台，必要時可開 CORS
  cors: { origin: "*" }
});
app.use(express.static('public'));

/** ====== 內存（無資料庫）狀態 ======
 * 全部狀態只在記憶體：重啟就清空
 */
const state = {
  mode: 'solo', // 'solo' 或 'group'
  adminKey: process.env.ADMIN_KEY || 'letmein', // 超簡易「管理金鑰」
  players: {}, // socketId -> { name, team: string|null, score: number }
  teams: new Set(), // 所有隊伍名稱（由 admin 指派 / 建立）
  presentation: 'rank', // admin 可切換結果呈現方式: 'rank' | 'table'
};

/** ====== 工具：計算整合結果 ====== */
function computeLeaderboard() {
  if (state.mode === 'solo') {
    // 個人賽：列出所有玩家分數
    const list = Object.entries(state.players)
      .map(([id, p]) => ({ id, name: p.name, score: p.score, team: p.team }))
      .sort((a, b) => b.score - a.score);
    return { mode: 'solo', players: list };
  } else {
    // 分組賽：彙總各隊總分
    const teamScores = {};
    for (const t of state.teams) teamScores[t] = 0;
    for (const p of Object.values(state.players)) {
      const team = p.team || '未分組';
      if (!(team in teamScores)) teamScores[team] = 0;
      teamScores[team] += p.score;
    }
    const list = Object.entries(teamScores)
      .map(([team, score]) => ({ team, score }))
      .sort((a, b) => b.score - a.score);
    return { mode: 'group', teams: list };
  }
}

/** ====== 廣播全體狀態（給 admin 與 client 都可用） ====== */
function broadcastState() {
  io.emit('state:update', {
    mode: state.mode,
    presentation: state.presentation,
    leaderboard: computeLeaderboard(),
    onlineCount: Object.keys(state.players).length,
  });
}

/** ====== Socket.IO 事件 ====== */
io.on('connection', (socket) => {
  // 使用者或管理員連進來，先等候身分宣告
  // 1) 客戶端宣告加入（玩家）
  socket.on('client:join', ({ name }) => {
    state.players[socket.id] = {
      name: name?.trim() || '玩家',
      team: null,
      score: 0,
    };
    broadcastState();
  });

  // 2) 客戶端提交分數變動（這裡用 +1/-1 模擬；實務中可改成提交答案得分）
  socket.on('client:scoreDelta', (delta) => {
    const p = state.players[socket.id];
    if (!p) return;
    const d = Number(delta) || 0;
    p.score += d;
    if (p.score < 0) p.score = 0;
    broadcastState();
  });

  // 3) 客戶端自訂顯示名稱
  socket.on('client:rename', (newName) => {
    const p = state.players[socket.id];
    if (!p) return;
    p.name = (newName || '').trim() || p.name;
    broadcastState();
  });

  // 4) Admin 驗證（前端會帶 adminKey）
  socket.on('admin:auth', ({ adminKey }) => {
    if (adminKey === state.adminKey) {
      socket.data.isAdmin = true;
      socket.emit('admin:auth:ok', { ok: true });
      // 回傳當前狀態
      socket.emit('state:update', {
        mode: state.mode,
        presentation: state.presentation,
        leaderboard: computeLeaderboard(),
        onlineCount: Object.keys(state.players).length,
      });
    } else {
      socket.emit('admin:auth:ok', { ok: false });
    }
  });

  // 5) Admin 切換模式（solo / group）
  socket.on('admin:setMode', ({ mode }) => {
    if (!socket.data.isAdmin) return;
    if (mode === 'solo' || mode === 'group') {
      state.mode = mode;
      broadcastState();
    }
  });

  // 6) Admin 設定結果呈現方式（rank / table）
  socket.on('admin:setPresentation', ({ type }) => {
    if (!socket.data.isAdmin) return;
    if (['rank', 'table'].includes(type)) {
      state.presentation = type;
      broadcastState();
    }
  });

  // 7) Admin 建立/覆蓋隊伍清單（如 ['A', 'B', 'C']）
  socket.on('admin:setTeams', ({ teamList }) => {
    if (!socket.data.isAdmin) return;
    state.teams = new Set((teamList || []).map(t => String(t).trim()).filter(Boolean));
    // 若玩家原本隊伍不在清單中，保留其文字，或設為 null（這裡保留原值）
    broadcastState();
  });

  // 8) Admin 指派玩家到某隊
  socket.on('admin:assignTeam', ({ playerId, team }) => {
    if (!socket.data.isAdmin) return;
    if (state.players[playerId]) {
      state.players[playerId].team = team || null;
      if (team) state.teams.add(team);
      broadcastState();
    }
  });

  // 9) Admin 重設所有人分數
  socket.on('admin:resetScores', () => {
    if (!socket.data.isAdmin) return;
    for (const p of Object.values(state.players)) p.score = 0;
    broadcastState();
  });

  // 10) Admin 清空所有玩家（但保留模式/隊伍）
  socket.on('admin:clearPlayers', () => {
    if (!socket.data.isAdmin) return;
    state.players = {};
    broadcastState();
  });

  // 離線處理
  socket.on('disconnect', () => {
    if (state.players[socket.id]) {
      delete state.players[socket.id];
      broadcastState();
    }
  });
});

/** ====== 啟動伺服器 ====== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
