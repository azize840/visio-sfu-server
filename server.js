require('dotenv').config();

const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const dns = require('dns').promises;

const app = express();

app.use(cors({
    origin: [
        'https://pandurate-squatly-hae.ngrok-free.dev',
        'https://visiocampus-socketio-2.onrender.com',
        'https://visio-peerjs-server-4.onrender.com',
        'http://localhost:3000',
        'http://localhost:8000',
        'http://localhost:5173'
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));

app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({
    server,
    path: '/ws'
});

// ==================== CONFIGURATION TURN UNIQUEMENT (pas de STUN) ====================
const ICE_SERVERS = [
    {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000
        }
    }
];

let worker;
let rooms = new Map();
const connections = new Map();
let cachedPublicIp = null;

// ==================== RÉSOLUTION IP PUBLIQUE ====================
async function getPublicIp() {
    if (cachedPublicIp) return cachedPublicIp;

    try {
        // Méthode 1: DNS
        if (process.env.RENDER_EXTERNAL_HOSTNAME) {
            try {
                const addresses = await dns.resolve4(process.env.RENDER_EXTERNAL_HOSTNAME);
                if (addresses && addresses.length > 0) {
                    cachedPublicIp = addresses[0];
                    console.log(`✅ IP résolue via DNS: ${cachedPublicIp}`);
                    return cachedPublicIp;
                }
            } catch (err) {
                console.warn(`⚠️ DNS failed: ${err.message}`);
            }
        }

        // Méthode 2: Service externe
        const https = require('https');
        const ip = await new Promise((resolve, reject) => {
            https.get('https://api.ipify.org', (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data.trim()));
            }).on('error', reject);
        });

        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
            cachedPublicIp = ip;
            console.log(`✅ IP via ipify: ${cachedPublicIp}`);
            return cachedPublicIp;
        }
    } catch (error) {
        console.error('❌ Erreur récupération IP:', error.message);
    }

    console.warn('⚠️ Fallback à 0.0.0.0');
    return '0.0.0.0';
}

// ==================== WORKER MEDIASOUP ====================
async function createWorker() {
    worker = await mediasoup.createWorker({
        logLevel: 'debug',
        rtcMinPort: 40000,
        rtcMaxPort: 40099, // Petit range pour Render
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    });

    console.log('✅ Worker Mediasoup créé');

    worker.on('died', () => {
        console.error('❌ Worker died');
        process.exit(1);
    });

    return worker;
}

// ==================== WEBSOCKET CLIENT ====================
async function handleMediasoupClient(ws, roomId, participantId) {
    console.log(`🔗 Client: ${participantId} → Room: ${roomId}`);

    if (!rooms.has(roomId)) {
        ws.send(JSON.stringify({ action: 'error', error: 'Room non trouvée' }));
        return;
    }

    const room = rooms.get(roomId);
    const connectionId = `${roomId}-${participantId}`;

    const connection = {
        ws,
        roomId,
        participantId,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        router: room.router,
        joinedAt: new Date()
    };

    connections.set(connectionId, connection);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleMediasoupMessage(connection, data);
        } catch (error) {
            console.error('❌ Erreur message:', error);
            ws.send(JSON.stringify({ action: 'error', error: error.message }));
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Déconnexion: ${participantId}`);
        cleanupConnection(connectionId, roomId);
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket error: ${participantId}`, error);
        cleanupConnection(connectionId, roomId);
    });

    // Envoyer capacités RTP + ICE servers
    ws.send(JSON.stringify({
        action: 'rtp-capabilities',
        rtpCapabilities: room.router.rtpCapabilities,
        iceServers: ICE_SERVERS
    }));
}

async function handleMediasoupMessage(connection, data) {
    const { action } = data;

    switch (action) {
        case 'create-transport':
            await handleCreateTransport(connection, data);
            break;
        case 'connect-transport':
            await handleConnectTransport(connection, data);
            break;
        case 'produce':
            await handleProduce(connection, data);
            break;
        case 'consume':
            await handleConsume(connection, data);
            break;
        case 'resume-consumer':
            await handleResumeConsumer(connection, data);
            break;
        case 'get-producers':
            await handleGetProducers(connection, data);
            break;
    }
}

// ==================== CRÉATION TRANSPORT - TCP UNIQUEMENT ====================
async function handleCreateTransport(connection, data) {
    const { ws, router, transports, participantId } = connection;
    const { direction } = data;

    const announcedIp = await getPublicIp();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🚗 Création transport ${direction.toUpperCase()}`);
    console.log(`👤 Participant: ${participantId}`);
    console.log(`🌐 IP annoncée: ${announcedIp}`);
    console.log(`${'='.repeat(80)}`);

    // ⚠️ CRITIQUE: enableUdp = false pour Render
    const transport = await router.createWebRtcTransport({
        listenIps: [
            {
                ip: '0.0.0.0',
                announcedIp: announcedIp
            }
        ],
        enableUdp: false,  // ✅ DÉSACTIVÉ car Render ne supporte pas UDP range
        enableTcp: true,   // ✅ ACTIVÉ (TCP uniquement)
        preferUdp: false,  // ✅ Forcer TCP
        preferTcp: true,   // ✅ Forcer TCP
        initialAvailableOutgoingBitrate: 800000,
        minimumAvailableOutgoingBitrate: 400000,
        maxSctpMessageSize: 262144
    });

    transports.set(transport.id, transport);

    // Logs de debug
    console.log(`📊 ICE Candidates: ${transport.iceCandidates.length}`);
    transport.iceCandidates.forEach((candidate, i) => {
        console.log(`   ${i + 1}. ${candidate.protocol.toUpperCase()} ${candidate.ip}:${candidate.port} (type: ${candidate.type})`);

        // Vérifier si IP privée
        const isPrivate = candidate.ip === '0.0.0.0' ||
                         candidate.ip === '127.0.0.1' ||
                         candidate.ip.startsWith('192.168') ||
                         candidate.ip.startsWith('10.') ||
                         candidate.ip.startsWith('172.');

        if (isPrivate) {
            console.error(`      ❌ IP PRIVÉE: ${candidate.ip}`);
        } else {
            console.log(`      ✅ IP PUBLIQUE: ${candidate.ip}`);
        }
    });

    // Événements transport
    transport.on('icestatechange', (state) => {
        console.log(`🧊 [${direction}] ICE state: ${state}`);
        if (state === 'checking') {
            console.log(`   → Tentative de connexion ICE en cours...`);
        } else if (state === 'connected') {
            console.log(`   ✅ ICE connecté!`);
        } else if (state === 'failed') {
            console.error(`   ❌ ICE FAILED - Le transport ne peut pas se connecter`);
        }
    });

    transport.on('dtlsstatechange', (state) => {
        console.log(`🔐 [${direction}] DTLS state: ${state}`);
    });

    transport.on('iceselectedtuplechange', (tuple) => {
        console.log(`🎯 [${direction}] ICE Selected Tuple:`);
        console.log(`   Local:  ${tuple.localIp}:${tuple.localPort} (${tuple.protocol})`);
        console.log(`   Remote: ${tuple.remoteIp}:${tuple.remotePort}`);
    });

    transport.on('close', () => {
        console.log(`🚗 Transport fermé: ${transport.id}`);
        transports.delete(transport.id);
    });

    // Envoyer au client
    ws.send(JSON.stringify({
        action: 'transport-created',
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        direction: direction,
        iceServers: ICE_SERVERS
    }));

    console.log(`✅ Transport ${direction} créé et envoyé`);
    console.log(`${'='.repeat(80)}\n`);
}

async function handleConnectTransport(connection, data) {
    const { transports } = connection;
    const { transportId, dtlsParameters } = data;

    const transport = transports.get(transportId);
    if (!transport) {
        throw new Error(`Transport non trouvé: ${transportId}`);
    }

    await transport.connect({ dtlsParameters });
    console.log(`✅ Transport connecté: ${transportId}`);
}

async function handleProduce(connection, data) {
    const { ws, transports, producers, participantId, roomId } = connection;
    const { transportId, kind, rtpParameters } = data;

    const transport = transports.get(transportId);
    if (!transport) {
        throw new Error(`Transport non trouvé: ${transportId}`);
    }

    const producer = await transport.produce({ kind, rtpParameters });
    producers.set(producer.id, producer);

    broadcastToRoom(roomId, participantId, {
        action: 'new-producer',
        participantId: participantId,
        producerId: producer.id,
        kind: kind
    });

    ws.send(JSON.stringify({
        action: 'produced',
        id: producer.id,
        kind: kind
    }));

    console.log(`✅ Producer ${kind}: ${producer.id} (${participantId})`);

    producer.on('transportclose', () => {
        producer.close();
        producers.delete(producer.id);
    });
}

async function handleConsume(connection, data) {
    const { ws, transports, consumers, router, participantId } = connection;
    const { transportId, producerId, rtpCapabilities } = data;

    try {
        if (!router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error('Cannot consume');
        }

        const transport = transports.get(transportId);
        if (!transport) {
            throw new Error(`Transport non trouvé: ${transportId}`);
        }

        const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: false
        });

        consumers.set(consumer.id, consumer);

        const producerParticipantId = getParticipantIdFromProducer(producerId);

        ws.send(JSON.stringify({
            action: 'consumed',
            id: consumer.id,
            producerId: producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            participantId: producerParticipantId
        }));

        console.log(`✅ Consumer ${consumer.kind}: ${consumer.id} (${participantId})`);

        consumer.on('transportclose', () => {
            consumer.close();
            consumers.delete(consumer.id);
        });

        consumer.on('producerclose', () => {
            ws.send(JSON.stringify({
                action: 'producer-closed',
                producerId: producerId,
                consumerId: consumer.id
            }));
            consumer.close();
            consumers.delete(consumer.id);
        });

    } catch (error) {
        console.error(`❌ Erreur consume:`, error);
        ws.send(JSON.stringify({ action: 'error', error: error.message }));
    }
}

function getParticipantIdFromProducer(producerId) {
    for (const [connectionId, connection] of connections.entries()) {
        if (connection.producers.has(producerId)) {
            return connection.participantId;
        }
    }
    return 'unknown';
}

async function handleResumeConsumer(connection, data) {
    const { consumers, ws } = connection;
    const { consumerId } = data;

    const consumer = consumers.get(consumerId);
    if (!consumer) {
        throw new Error(`Consumer non trouvé: ${consumerId}`);
    }

    await consumer.resume();

    ws.send(JSON.stringify({
        action: 'consumer-resumed',
        consumerId: consumerId
    }));

    console.log(`✅ Consumer résumé: ${consumerId}`);
}

async function handleGetProducers(connection, data) {
    const { roomId, participantId, ws } = connection;

    const allProducers = [];
    for (const [connId, conn] of connections.entries()) {
        if (conn.roomId === roomId && conn.participantId !== participantId) {
            for (const producer of conn.producers.values()) {
                allProducers.push({
                    participantId: conn.participantId,
                    producerId: producer.id,
                    kind: producer.kind
                });
            }
        }
    }

    ws.send(JSON.stringify({
        action: 'producers',
        producers: allProducers
    }));
}

function broadcastToRoom(roomId, excludeParticipantId, message) {
    for (const [connId, conn] of connections.entries()) {
        if (conn.roomId === roomId && conn.participantId !== excludeParticipantId) {
            if (conn.ws.readyState === 1) {
                conn.ws.send(JSON.stringify(message));
            }
        }
    }
}

function cleanupConnection(connectionId, roomId) {
    const connection = connections.get(connectionId);
    if (connection) {
        for (const transport of connection.transports.values()) {
            try {
                transport.close();
            } catch (error) {}
        }

        broadcastToRoom(roomId, connection.participantId, {
            action: 'participant-left',
            participantId: connection.participantId
        });

        connections.delete(connectionId);
    }
}

// ==================== ROUTES API ====================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'VisioCampus Mediasoup SFU - TCP Only',
        version: '3.2.0',
        timestamp: new Date().toISOString(),
        publicIp: cachedPublicIp,
        transport: 'TCP only (Render compatible)',
        iceServers: ICE_SERVERS
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rooms: rooms.size,
        connections: connections.size,
        publicIp: cachedPublicIp
    });
});

app.post('/rooms', async (req, res) => {
    try {
        const { room_id, max_participants = 50 } = req.body;

        if (!room_id) {
            return res.status(400).json({ success: false, error: 'room_id requis' });
        }

        if (rooms.has(room_id)) {
            const room = rooms.get(room_id);
            return res.json({
                success: true,
                room_id,
                exists: true,
                rtp_capabilities: room.router.rtpCapabilities
            });
        }

        const router = await worker.createRouter({ mediaCodecs });

        rooms.set(room_id, {
            router,
            roomId: room_id,
            createdAt: new Date(),
            maxParticipants: max_participants
        });

        console.log(`✅ Room créée: ${room_id}`);

        res.json({
            success: true,
            room_id,
            exists: false,
            max_participants,
            rtp_capabilities: router.rtpCapabilities
        });

    } catch (error) {
        console.error('❌ Erreur création room:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/tokens', async (req, res) => {
    try {
        const { room_id, participant_id } = req.body;

        if (!room_id || !participant_id) {
            return res.status(400).json({ success: false, error: 'room_id et participant_id requis' });
        }

        if (!rooms.has(room_id)) {
            return res.status(404).json({ success: false, error: 'Room non trouvée' });
        }

        const room = rooms.get(room_id);
        const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`;
        const websocketUrl = serverUrl.replace('http', 'ws') + '/ws';

        res.json({
            success: true,
            room_id,
            participant_id,
            rtp_capabilities: room.router.rtpCapabilities,
            server_url: websocketUrl,
            ice_servers: ICE_SERVERS,
            max_participants: room.maxParticipants,
            current_participants: Array.from(connections.values()).filter(c => c.roomId === room_id).length
        });

    } catch (error) {
        console.error('❌ Erreur token:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== WEBSOCKETS ====================
wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('roomId');
    const participantId = url.searchParams.get('participantId');

    if (!roomId || !participantId || !rooms.has(roomId)) {
        ws.send(JSON.stringify({ action: 'error', error: 'Paramètres invalides' }));
        ws.close();
        return;
    }

    handleMediasoupClient(ws, roomId, participantId);
});

// ==================== DÉMARRAGE ====================
async function startServer() {
    try {
        console.log('🔍 Résolution IP publique...');
        await getPublicIp();
        console.log(`✅ IP: ${cachedPublicIp}`);

        await createWorker();

        const PORT = process.env.PORT || 3001;

        server.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(80));
            console.log('🚀 VISIOCAMPUS MEDIASOUP SFU - TCP ONLY (RENDER)');
            console.log('='.repeat(80));
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌐 IP publique: ${cachedPublicIp}`);
            console.log(`⚠️  Transport: TCP UNIQUEMENT (UDP désactivé)`);
            console.log(`🎯 TURN: openrelay.metered.ca:443`);
            console.log('='.repeat(80) + '\n');
        });
    } catch (error) {
        console.error('❌ Erreur démarrage:', error);
        process.exit(1);
    }
}

// ==================== SHUTDOWN ====================
const gracefulShutdown = async () => {
    console.log('\n🛑 Arrêt...');
    if (worker) worker.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startServer();
