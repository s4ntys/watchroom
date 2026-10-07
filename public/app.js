const $ = id => document.getElementById(id);
const socket = io({ reconnection: true });
const player = $('player');
const landing = $('landing');
const roomPanel = $('room');
const peers = new Map();
const iceQueue = new Map();
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let roomId = new URLSearchParams(location.search).get('room');
let hostToken = null;
let role = 'viewer';
let localStream = null;
let objectUrl = null;
let sourceKind = null;
let joining = false;

function notify(message) { $('error').textContent = message; $('error').classList.remove('hidden'); setTimeout(() => $('error').classList.add('hidden'), 8500); }
function status(message) { $('status').textContent = message; }
function isHost() { return role === 'host'; }
function showRoom() {
  landing.classList.add('hidden'); roomPanel.classList.remove('hidden');
  $('rolePill').textContent = isHost() ? 'MODERÁTOR' : 'DIVÁK';
  $('hostControls').classList.toggle('hidden', !isHost());
  $('viewerPanel').classList.toggle('hidden', isHost());
  player.controls = isHost();
  player.disablePictureInPicture = !isHost();
  $('emptyTitle').textContent = isHost() ? 'Pripravené na vysielanie' : 'Vysielanie ešte nezačalo';
  $('emptyText').textContent = isHost() ? 'Vyber video alebo začni zdieľať kartu.' : 'Keď moderátor spustí video, zobrazí sa tu.';
}
function setLive(live) {
  $('empty').classList.toggle('hidden', live);
  $('liveBadge').classList.toggle('hidden', !live);
}
function linkForRoom() { return `${location.origin}/?room=${encodeURIComponent(roomId)}`; }
function storeKey(room) { return `watchroom_host_${room}`; }
function createRoom() {
  socket.emit('create-room', result => {
    if (!result?.ok) return notify(result?.error || 'Nepodarilo sa vytvoriť miestnosť.');
    roomId = result.roomId; hostToken = result.token; role = 'host';
    sessionStorage.setItem(storeKey(roomId), hostToken);
    history.replaceState(null, '', `/?room=${encodeURIComponent(roomId)}`);
    showRoom(); status('Miestnosť vytvorená • čaká na vysielanie');
  });
}
function joinRoom() {
  if (!roomId || !socket.connected || joining) return;
  joining = true;
  hostToken = sessionStorage.getItem(storeKey(roomId));
  socket.emit('join-room', { roomId, token: hostToken }, result => {
    joining = false;
    if (!result?.ok) { notify(result?.error || 'Pripojenie zlyhalo.'); status('Miestnosť nie je dostupná'); return; }
    role = result.role; showRoom();
    status(result.live ? 'Pripájam živý stream…' : 'Čaká sa na stream moderátora');
    if (result.live && !isHost()) socket.emit('request-stream');
    if (!result.live && !isHost()) { player.srcObject = null; setLive(false); }
    if (isHost() && localStream) {
      for (const [id, peer] of peers) { peer.close(); peers.delete(id); }
      socket.emit('host-status', { live: true, source: sourceKind });
    }
  });
}
function closePeer(id) { const peer = peers.get(id); if (peer) peer.close(); peers.delete(id); iceQueue.delete(id); }
function closeAllPeers() { for (const id of peers.keys()) closePeer(id); }
function makePeer(id) {
  const pending = iceQueue.get(id) || [];
  closePeer(id);
  const peer = new RTCPeerConnection(rtcConfig);
  peers.set(id, peer);
  iceQueue.set(id, pending);
  peer.onicecandidate = evt => { if (evt.candidate) socket.emit('signal', { target: id, data: { type: 'candidate', candidate: evt.candidate } }); };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') status('P2P pripojenie zlyhalo. Možno bude potrebný TURN server.');
  };
  if (isHost() && localStream) localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
  if (!isHost()) {
    peer.ontrack = event => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (player.srcObject !== stream) player.srcObject = stream;
      setLive(true); status('Sleduješ živé vysielanie');
      player.play().catch(() => status('Klikni na prehrávač pre spustenie zvuku / videa.'));
    };
  }
  return peer;
}
async function flushCandidates(id, peer) {
  const queue = iceQueue.get(id) || [];
  iceQueue.set(id, []);
  for (const candidate of queue) try { await peer.addIceCandidate(candidate); } catch (error) { console.warn('ICE:', error); }
}
async function offerToViewer(viewerId) {
  if (!isHost() || !localStream) return;
  const peer = makePeer(viewerId);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  socket.emit('signal', { target: viewerId, data: { type: 'offer', sdp: peer.localDescription } });
}
async function startStream(stream, kind) {
  if (!stream?.getVideoTracks().length) throw Error('Zdroj neobsahuje video.');
  if (localStream) stopStream(false);
  localStream = stream; sourceKind = kind;
  for (const track of stream.getTracks()) track.addEventListener('ended', () => {
    if (localStream === stream && stream.getVideoTracks().every(t => t.readyState === 'ended')) stopStream();
  });
  closeAllPeers();
  socket.emit('host-status', { live: true, source: kind });
  setLive(true); status(kind === 'screen' ? 'Vysielaš zdieľanú kartu / obrazovku' : 'Vysielaš video');
  // Viewers request fresh offers upon receiving the live status.
}
function stopStream(broadcast = true) {
  const old = localStream;
  localStream = null; sourceKind = null;
  closeAllPeers();
  old?.getTracks().forEach(t => t.stop());
  player.pause(); player.srcObject = null;
  player.removeAttribute('src'); player.load();
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  setLive(false);
  if (broadcast && isHost()) socket.emit('host-status', { live: false, source: null });
  status('Vysielanie zastavené');
}
async function captureVideo(src, isObjectUrl = false) {
  stopStream();
  player.crossOrigin = isObjectUrl ? null : 'anonymous';
  player.src = src;
  player.muted = false;
  player.controls = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('Načítanie videa trvá príliš dlho.')); }, 15000);
      const cleanup = () => { clearTimeout(timer); player.removeEventListener('loadedmetadata', ok); player.removeEventListener('error', bad); };
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(Error('Video sa nepodarilo načítať. Skús zdieľanie karty.')); };
      player.addEventListener('loadedmetadata', ok); player.addEventListener('error', bad);
    });
    await player.play();
    const capture = player.captureStream || player.mozCaptureStream;
    if (!capture) throw Error('Tento prehliadač nepodporuje zachytenie video prehrávača. Použi Chrome alebo Edge a zdieľanie karty.');
    const stream = capture.call(player);
    await startStream(stream, 'video');
  } catch (error) { notify(error.message); status('Video sa nepodarilo spustiť'); }
}
async function shareScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    stopStream();
    player.removeAttribute('src'); player.srcObject = stream; player.muted = true;
    await player.play();
    await startStream(stream, 'screen');
    if (!stream.getAudioTracks().length) notify('Prehliadač neposkytol zvuk. Pri výbere karty povoľ „Zdieľať aj zvuk karty“.');
  } catch (error) { if (error.name !== 'NotAllowedError') notify('Zdieľanie zlyhalo: ' + error.message); }
}

socket.on('connect', () => { if (roomId) joinRoom(); });
socket.on('disconnect', () => { closeAllPeers(); status('Spojenie so serverom prerušené…'); });
socket.on('room-state', state => { $('count').textContent = state.viewers; if (!isHost() && !state.live) { setLive(false); player.srcObject = null; } });
socket.on('viewer-joined', ({ viewerId }) => { if (isHost() && localStream) offerToViewer(viewerId).catch(e => notify(e.message)); });
socket.on('viewer-left', ({ viewerId }) => closePeer(viewerId));
socket.on('playback-status', ({ live }) => {
  if (!isHost() && !live) { setLive(false); player.srcObject = null; closeAllPeers(); status('Moderátor zastavil vysielanie'); }
  if (!isHost() && live && !player.srcObject) socket.emit('request-stream');
});
socket.on('host-left', () => { if (!isHost()) { closeAllPeers(); player.srcObject = null; setLive(false); status('Moderátor sa odpojil. Čaká sa na návrat…'); } });
socket.on('room-closed', () => { stopStream(false); notify('Miestnosť bola ukončená.'); });
socket.on('signal', async ({ from, data }) => {
  try {
    if (data.type === 'offer' && !isHost()) {
      const peer = makePeer(from);
      await peer.setRemoteDescription(data.sdp);
      await flushCandidates(from, peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit('signal', { target: from, data: { type: 'answer', sdp: peer.localDescription } });
    } else if (data.type === 'answer' && isHost()) {
      const peer = peers.get(from);
      if (peer) { await peer.setRemoteDescription(data.sdp); await flushCandidates(from, peer); }
    } else if (data.type === 'candidate') {
      let peer = peers.get(from);
      if (!peer) {
        // ICE may arrive before the SDP. Buffer it without creating an RTCPeerConnection.
        const pending = iceQueue.get(from) || []; pending.push(data.candidate); iceQueue.set(from, pending); return;
      }
      if (peer.remoteDescription) await peer.addIceCandidate(data.candidate);
      else iceQueue.get(from)?.push(data.candidate);
    }
  } catch (error) { console.error(error); status('Chyba pri nadväzovaní video spojenia'); }
});
$('create').onclick = createRoom;
$('createTop').onclick = createRoom;
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(linkForRoom()); $('copy').textContent = '✓ Skopírované'; setTimeout(() => $('copy').textContent = '⧉ Kopírovať pozvánku', 2200); } catch { notify('Odkaz: ' + linkForRoom()); } };
document.querySelectorAll('.tab').forEach(button => button.onclick = () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === button));
  for (const tab of ['url', 'file', 'screen']) $(tab + 'Tab').classList.toggle('hidden', button.dataset.tab !== tab);
});
$('loadUrl').onclick = () => { const url = $('url').value.trim(); try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw Error(); captureVideo(url); } catch { notify('Zadaj platnú HTTP alebo HTTPS adresu videa.'); } };
$('loadFile').onclick = () => { const file = $('file').files[0]; if (!file) return notify('Vyber video súbor.'); const url = URL.createObjectURL(file); captureVideo(url, true); objectUrl = url; };
$('shareScreen').onclick = shareScreen;
$('play').onclick = () => { if (!isHost()) return; if (sourceKind === 'video') player.play().catch(e => notify(e.message)); };
$('pause').onclick = () => { if (!isHost()) return; if (sourceKind === 'video') player.pause(); };
$('stop').onclick = () => { if (isHost()) stopStream(); };
player.addEventListener('ended', () => { if (isHost() && sourceKind === 'video') stopStream(); });
if (roomId) status('Pripájam sa k miestnosti…');
