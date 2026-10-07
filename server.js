import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from 'socket.io';

const app = express();
app.disable('x-powered-by');
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true }));
const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 1e6, cors: { origin: false } });
const rooms = new Map();
const MAX_VIEWERS = 12; // mesh: appropriate for small rooms only
const id = (bytes = 9) => randomBytes(bytes).toString('base64url');
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function publish(room) {
  io.to(room.id).emit('room-state', { viewers: room.viewers.size, hostOnline: Boolean(room.hostSocket), live: room.live, source: room.source });
}
function fail(ack, message) { ack?.({ ok: false, error: message }); }
function hostRoom(socket) {
  const room = rooms.get(socket.data.roomId);
  return room && room.hostSocket === socket.id ? room : null;
}
function leave(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return;
  if (room.hostSocket === socket.id) {
    room.hostSocket = null;
    room.live = false;
    io.to(room.id).emit('host-left');
    if (room.cleanup) clearTimeout(room.cleanup);
    room.cleanup = setTimeout(() => { if (!room.hostSocket) { io.to(room.id).emit('room-closed'); rooms.delete(room.id); } }, 60_000);
  } else {
    room.viewers.delete(socket.id);
    io.to(room.hostSocket || '').emit('viewer-left', { viewerId: socket.id });
  }
  socket.leave(room.id);
  socket.data.roomId = null;
  publish(room);
}

io.on('connection', socket => {
  socket.on('create-room', ack => {
    leave(socket);
    const roomId = id(6); const token = id(32);
    const room = { id: roomId, token, hostSocket: socket.id, viewers: new Set(), live: false, source: null, cleanup: null };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    ack?.({ ok: true, roomId, token });
    publish(room);
  });
  socket.on('join-room', ({ roomId, token } = {}, ack) => {
    if (typeof roomId !== 'string' || !/^[\w-]{8}$/.test(roomId)) return fail(ack, 'Neplatný odkaz na miestnosť.');
    const room = rooms.get(roomId);
    if (!room) return fail(ack, 'Miestnosť neexistuje alebo už skončila.');
    const isHost = safeEqual(token, room.token);
    if (!isHost && room.viewers.size >= MAX_VIEWERS) return fail(ack, 'Miestnosť je plná.');
    if (isHost && room.hostSocket && room.hostSocket !== socket.id) return fail(ack, 'Moderátor je už pripojený v inom okne.');
    leave(socket);
    socket.join(roomId); socket.data.roomId = roomId;
    if (isHost) {
      if (room.cleanup) clearTimeout(room.cleanup);
      room.cleanup = null; room.hostSocket = socket.id;
    } else {
      room.viewers.add(socket.id);
    }
    ack?.({ ok: true, role: isHost ? 'host' : 'viewer', live: room.live, source: room.source });
    if (!isHost && room.hostSocket) io.to(room.hostSocket).emit('viewer-joined', { viewerId: socket.id });
    publish(room);
  });
  socket.on('request-stream', () => {
    const room = rooms.get(socket.data.roomId);
    if (room?.live && room.hostSocket && room.viewers.has(socket.id)) io.to(room.hostSocket).emit('viewer-joined', { viewerId: socket.id });
  });
  socket.on('host-status', ({ live, source } = {}) => {
    const room = hostRoom(socket); if (!room) return;
    room.live = live === true;
    room.source = typeof source === 'string' ? source.slice(0, 100) : null;
    publish(room);
    io.to(room.id).emit('playback-status', { live: room.live });
  });
  socket.on('playback-action', ({ action } = {}) => {
    const room = hostRoom(socket);
    if (room && ['play', 'pause'].includes(action)) socket.to(room.id).emit('playback-action', { action });
  });
  socket.on('signal', ({ target, data } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || typeof target !== 'string' || !data || !['offer', 'answer', 'candidate'].includes(data.type)) return;
    const host = room.hostSocket === socket.id;
    if (host && !room.viewers.has(target)) return;
    if (!host && (!room.viewers.has(socket.id) || target !== room.hostSocket)) return;
    io.to(target).emit('signal', { from: socket.id, data });
  });
  socket.on('disconnect', () => leave(socket));
});
const port = Number(process.env.PORT || 3000);
httpServer.listen(port, '0.0.0.0', () => console.log(`WatchRoom: http://localhost:${port}`));
