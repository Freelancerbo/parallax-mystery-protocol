const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, pingInterval: 25000, pingTimeout: 20000 });
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'PARALLAX' }));

const rooms = new Map();
const missions = [
  { title: 'Ghost in the Grid', type: 'HACKING', brief: 'A relay station has gone dark. Decode the access sequence before the city loses power.', question: 'Which sequence completes the relay key?', options: ['3 · 6 · 12 · 24 · ?', '2 · 5 · 11 · 20 · ?', '1 · 4 · 9 · 15 · ?'], answer: 0, intel: 'The relay logs mention a second signal beneath the city.' },
  { title: 'The Glass Vote', type: 'STRATEGY', brief: 'NEXUS is moving through the civic network. Choose a small strike team and decide whom to trust.', question: 'Which action best protects a compromised network?', options: ['Isolate affected nodes', 'Broadcast every access key', 'Disable all backups'], answer: 0, intel: 'A hidden protocol called ECHO may be older than NEXUS.' },
  { title: 'Reactor Nine', type: 'EMERGENCY', brief: 'The reactor is overheating. Every second matters. Stabilize the core with the correct response.', question: 'The core temperature rises 8° every 10 seconds. It is 72° now. What will it be in 30 seconds?', options: ['88°', '96°', '102°'], answer: 1, intel: 'Someone on the team has been transmitting outside the mission channel.' },
  { title: 'Black Archive', type: 'HACKING', brief: 'An encrypted archive contains the truth about the city. Recover its checksum.', question: 'A checksum is used primarily to…', options: ['Verify data integrity', 'Increase screen brightness', 'Replace encryption keys'], answer: 0, intel: 'ECHO is not a weapon. It is a failsafe that can rewrite NEXUS.' },
  { title: 'The Last Signal', type: 'FINAL OPERATION', brief: 'One final operation stands between the city and permanent control. Make your choice count.', question: 'Which principle is safest for a critical system?', options: ['Least privilege access', 'One shared admin password', 'Disable audit logs'], answer: 0, intel: 'The final choice will decide what rises from the ruins.' }
];

const makeId = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const cleanName = s => String(s || '').trim().replace(/[<>]/g, '').slice(0, 18);
const roomOf = socket => {
  const code = socket.data.room;
  return code ? rooms.get(code) : null;
};
const playerOf = (room, socket) => room?.players.find(p => p.id === socket.id);
const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
const emitError = (socket, message) => socket.emit('game:error', message);

function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId, ready: !!p.ready })),
    round: room.round,
    successes: room.successes,
    failures: room.failures,
    captainId: room.captainId,
    proposedTeam: room.proposedTeam,
    votes: Object.fromEntries(room.votes),
    actionsSubmitted: room.actions.size,
    actionNeeded: room.proposedTeam.filter(id => !room.actions.has(id)).length,
    mission: room.round >= 0 && room.round < missions.length ? ((room.phase === 'mission' || room.phase === 'debrief' || room.phase === 'ended') ? { title: missions[room.round].title, type: missions[room.round].type, brief: missions[room.round].brief, question: missions[room.round].question, options: missions[room.round].options } : null) : null,
    lastResult: room.lastResult,
    ending: room.ending,
    rejectCount: room.rejectCount,
    log: room.log.slice(-12)
  };
}

function broadcast(room) {
  io.to(room.code).emit('game:state', publicState(room));
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('game:private', { role: p.role || null, clue: p.clue || null, isAgent: p.role === 'NEXUS', agentNames: room.status === 'ended' ? room.players.filter(x => x.role === 'NEXUS').map(x => x.name) : [] });
  });
}

function log(room, text) {
  room.log.push({ text, at: Date.now() });
  room.log = room.log.slice(-30);
}

function endGame(room, winner) {
  room.status = 'ended';
  room.phase = 'ended';

  const allAgentsFound = room.players.filter(p => p.role === 'NEXUS').every(p => room.accusations.has(p.id));

  if (winner === 'RESISTANCE' && room.successes >= 4) {
    room.ending = { title: 'CITY RESTORED', subtitle: 'The lights return. Humanity takes back the grid.', winner, code: 'RESTORED' };
  } else if (winner === 'RESISTANCE' && allAgentsFound) {
    room.ending = { title: 'THE AWAKENING', subtitle: 'The ECHO failsafe rewrites NEXUS. Something new begins.', winner, code: 'AWAKENING' };
  } else if (winner === 'RESISTANCE') {
    room.ending = { title: 'THE NEW ORDER', subtitle: 'The city survives, but its future remains uncertain.', winner, code: 'NEW_ORDER' };
  } else if (room.players.some(p => room.accusations.has(p.id))) {
    room.ending = { title: 'THE AWAKENING', subtitle: 'NEXUS wins the operation, but the truth escapes into the network.', winner, code: 'AWAKENING' };
  } else {
    room.ending = { title: 'NEXUS DOMINANCE', subtitle: 'The city goes silent. NEXUS controls every signal.', winner, code: 'DOMINANCE' };
  }

  log(room, winner === 'RESISTANCE' ? 'RESISTANCE VICTORY. The city has a future.' : 'NEXUS VICTORY. The city has fallen.');
}

function beginMission(room) {
  room.phase = 'team_vote';
  room.proposedTeam = [];
  room.votes.clear();
  room.actions.clear();
  room.lastResult = null;
  room.rejectCount = 0;
  room.captainId = room.players[room.round % room.players.length].id;

  log(room, \`MISSION \${room.round + 1}: \${missions[room.round].title}. Captain, propose your team.\`);
  broadcast(room);
}

function resolveMission(room) {
  const m = missions[room.round];

  const actions = [...room.actions.entries()].map(([id, a]) => ({
    id,
    ...a,
    player: room.players.find(p => p.id === id)
  }));

  const correct = actions.filter(a => !a.sabotage && a.answer === m.answer).length;
  const sabotage = actions.filter(a => a.sabotage).length;

  const passed = correct >= Math.ceil(room.proposedTeam.length / 2) && sabotage === 0;

  if (passed) room.successes++;
  else room.failures++;

  room.lastResult = {
    passed,
    correct,
    sabotage,
    required: Math.ceil(room.proposedTeam.length / 2),
    answer: m.answer,
    explanation: m.intel
  };

  room.phase = 'debrief';

  log(room, passed
    ? \`MISSION \${room.round + 1} SUCCESS. \${correct} correct signal(s), \${sabotage} sabotage(s).\`
    : \`MISSION \${room.round + 1} FAILED. \${correct} correct signal(s), \${sabotage} sabotage(s).\`
  );

  if (room.successes >= 3) endGame(room, 'RESISTANCE');
  else if (room.failures >= 3) endGame(room, 'NEXUS');

  broadcast(room);
}

io.on('connection', socket => {

  socket.on('room:create', ({ name }) => {
    const playerName = cleanName(name);

    if (!playerName) return emitError(socket, 'Enter a display name first.');

    let code;
    do {
      code = makeId();
    } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: playerName, connected: true, ready: true }],
      status: 'lobby',
      phase: 'lobby',
      round: -1,
      successes: 0,
      failures: 0,
      captainId: null,
      proposedTeam: [],
      votes: new Map(),
      actions: new Map(),
      rejectCount: 0,
      lastResult: null,
      ending: null,
      log: [],
      chat: [],
      accusations: new Set()
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code;

    socket.emit('room:joined', { code, id: socket.id });
    broadcast(room);
  });

  socket.on('room:join', ({ code, name }) => {
    code = String(code || '').trim().toUpperCase();
    const playerName = cleanName(name);
    const room = rooms.get(code);

    if (!playerName) return emitError(socket, 'Enter a display name first.');
    if (!room) return emitError(socket, 'Room not found. Check the code and try again.');
    if (room.status !== 'lobby') return emitError(socket, 'This game has already started.');
    if (room.players.length >= 8) return emitError(socket, 'This room is full.');

    if (room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return emitError(socket, 'That name is already taken in this room.');
    }

    room.players.push({ id: socket.id, name: playerName, connected: true, ready: true });

    socket.join(code);
    socket.data.room = code;

    socket.emit('room:joined', { code, id: socket.id });

    log(room, \`\${playerName} joined the operation.\`);
    broadcast(room);
  });

  socket.on('game:start', () => {
    const room = roomOf(socket);

    if (!room) return;
    if (socket.id !== room.hostId) return emitError(socket, 'Only the room host can launch the operation.');
    if (room.players.length < 4) return emitError(socket, 'You need at least 4 players to begin.');
    if (room.status !== 'lobby') return;

    const agentCount = room.players.length >= 6 ? 2 : 1;
    const agents = new Set(shuffle(room.players).slice(0, agentCount).map(p => p.id));

    room.players.forEach((p, i) => {
      p.role = agents.has(p.id) ? 'NEXUS' : 'RESISTANCE';
      p.clue = p.role === 'NEXUS'
        ? 'Your objective: quietly sabotage missions. You can coordinate in the private NEXUS channel.'
        : \`CLASSIFIED INTEL: \${['A signal repeats every 13 seconds.', 'The archive contains a hidden failsafe.', 'One teammate may not be who they claim.', 'Watch the voting patterns carefully.'][i % 4]}\`;
    });

    room.status = 'playing';
    room.round = 0;

    log(room, 'NEXUS is online. The operation begins now.');
    beginMission(room);
  });

  socket.on('team:propose', ({ playerIds }) => {
    const room = roomOf(socket);

    if (!room || room.phase !== 'team_vote') return;
    if (socket.id !== room.captainId) return emitError(socket, 'Only the current captain can propose a team.');
    if (!Array.isArray(playerIds)) return;

    const unique = [...new Set(playerIds)];
    const maxTeam = room.players.length <= 5 ? 2 : 3;

    if (unique.length < 2 || unique.length > maxTeam || unique.some(id => !room.players.some(p => p.id === id))) {
      return emitError(socket, \`Choose 2 to \${maxTeam} players for this mission.\`);
    }

    room.proposedTeam = unique;
    room.votes.clear();
    room.phase = 'vote';

    log(room, \`Captain proposed \${unique.map(id => room.players.find(p => p.id === id).name).join(', ')}. Vote to approve or reject.\`);
    broadcast(room);
  });

  socket.on('team:vote', ({ vote }) => {
    const room = roomOf(socket);

    if (!room || room.phase !== 'vote') return;
    if (!['yes', 'no'].includes(vote)) return;

    room.votes.set(socket.id, vote);
    broadcast(room);

    if (room.votes.size === room.players.length) {
      const yes = [...room.votes.values()].filter(v => v === 'yes').length;

      if (yes > room.players.length / 2) {
        room.phase = 'mission';
        log(room, 'Team approved. Selected players, submit your mission action.');
      } else {
        room.rejectCount++;
        room.phase = 'team_vote';
        room.proposedTeam = [];
        room.votes.clear();

        room.captainId = room.players[
          (room.players.findIndex(p => p.id === room.captainId) + 1) % room.players.length
        ].id;

        log(room, 'Team rejected. Captaincy moves to the next player.');

        if (room.rejectCount >= 3) {
          room.failures++;

          room.lastResult = {
            passed: false,
            correct: 0,
            sabotage: 0,
            required: 0,
            answer: null,
            explanation: 'The team could not agree. NEXUS exploited the delay.'
          };

          room.phase = 'debrief';
          log(room, 'The delay caused a mission failure.');

          if (room.failures >= 3) endGame(room, 'NEXUS');
        }
      }

      broadcast(room);
    }
  });

  socket.on('mission:action', ({ answer, sabotage }) => {
    const room = roomOf(socket);

    if (!room || room.phase !== 'mission') return;
    if (!room.proposedTeam.includes(socket.id)) return emitError(socket, 'Only selected team members can act.');
    if (room.actions.has(socket.id)) return emitError(socket, 'Your action has already been submitted.');

    const p = playerOf(room, socket);
    const m = missions[room.round];
    const isSabotage = p.role === 'NEXUS' && sabotage === true;
    const parsedAnswer = Number(answer);

    if (!Number.isInteger(parsedAnswer) || parsedAnswer < 0 || parsedAnswer >= m.options.length) {
      return emitError(socket, 'Choose an answer before submitting.');
    }

    room.actions.set(socket.id, { answer: parsedAnswer, sabotage: isSabotage });

    socket.emit('game:notice', 'Action locked. Your choice is sealed.');
    broadcast(room);

    if (room.actions.size === room.proposedTeam.length) {
      resolveMission(room);
    }
  });

  socket.on('mission:next', () => {
    const room = roomOf(socket);

    if (!room || room.phase !== 'debrief' || room.status === 'ended') return;
    if (socket.id !== room.hostId) return emitError(socket, 'Only the host can continue.');

    room.round++;

    if (room.round >= missions.length) {
      endGame(room, room.successes >= room.failures ? 'RESISTANCE' : 'NEXUS');
    } else {
      beginMission(room);
    }
  });

  socket.on('chat:send', ({ text, channel }) => {
    const room = roomOf(socket);
    const p = playerOf(room, socket);

    if (!room || !p || room.status === 'lobby') return;

    const message = String(text || '').trim().slice(0, 240);
    if (!message) return;

    if (channel === 'agent') {
      if (p.role !== 'NEXUS') return emitError(socket, 'This channel is restricted.');

      room.players.filter(x => x.role === 'NEXUS').forEach(agent => {
        const s = io.sockets.sockets.get(agent.id);

        if (s) {
          s.emit('chat:message', {
            name: p.name,
            text: message,
            channel: 'agent',
            at: Date.now()
          });
        }
      });
    } else {
      io.to(room.code).emit('chat:message', {
        name: p.name,
        text: message,
        channel: 'public',
        at: Date.now()
      });
    }
  });

  socket.on('player:accuse', ({ playerId }) => {
    const room = roomOf(socket);
    const p = playerOf(room, socket);

    if (!room || !p || room.status !== 'playing') return;
    if (!room.players.some(x => x.id === playerId) || playerId === socket.id) return;

    room.accusations.add(playerId);
    log(room, \`\${p.name} has flagged a player as suspicious.\`);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);

    if (!room) return;

    const p = playerOf(room, socket);
    if (p) p.connected = false;

    if (room.hostId === socket.id) {
      const next = room.players.find(x => x.connected);

      if (next) room.hostId = next.id;
      else rooms.delete(room.code);
    }

    log(room, \`\${p?.name || 'A player'} disconnected.\`);
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(\`PARALLAX online on port \${PORT}\`));
