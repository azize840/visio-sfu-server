require('dotenv').config();

const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const app = express();

// ==================== CONFIGURATION CORS POUR RENDER ====================
app.use(cors({
    origin: [
        'https://pandurate-squatly-hae.ngrok-free.dev',
        'https://visiocampus-socketio-1.onrender.com',
        'https://visio-peerjs-server-3.onrender.com',
        'http://localhost:3000',
        'http://localhost:8000',
        'http://localhost:5173'
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
}));

app.use(express.json());

// ==================== SERVEUR HTTP & WEBSOCKET ====================
const server = createServer(app);
const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, callback) => {
        callback(true);
    }
});

// ==================== CONFIGURATION MEDIASOUP ====================
const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: {
            minptime: 10,
            useinbandfec: 1
        }
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1000,
            'x-google-max-bitrate': 3000,
            'x-google-min-bitrate': 400
        }
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1
        }
    }
];

let worker;
let rooms = new Map();
const connections = new Map();

// ==================== CRÉATION DU WORKER MEDIASOUP ====================
async function createWorker() {
    worker = await mediasoup.createWorker({
        logLevel: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
        rtcMinPort: 10000,
        rtcMaxPort: 59999,
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    });

    console.log('✅ Worker Mediasoup créé');

    worker.on('died', () => {
        console.error('❌ Mediasoup worker died - Redémarrage nécessaire');
        process.exit(1);
    });

    return worker;
}

// ==================== GESTION DES CONNEXIONS WEBSOCKET ====================
async function handleMediasoupClient(ws, roomId, participantId) {
    console.log(`🔗 Nouveau client Mediasoup: ${participantId} dans room: ${roomId}`);

    if (!rooms.has(roomId)) {
        ws.send(JSON.stringify({
            action: 'error',
            error: 'Room non trouvée'
        }));
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
        router: room.router
    };

    connections.set(connectionId, connection);

    // Gestion des messages
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            await handleMediasoupMessage(connection, data);
        } catch (error) {
            console.error('❌ Erreur message Mediasoup:', error);
            ws.send(JSON.stringify({
                action: 'error',
                error: error.message
            }));
        }
    });

    // Nettoyage à la déconnexion
    ws.on('close', () => {
        console.log(`🔌 Déconnexion Mediasoup: ${participantId}`);
        cleanupConnection(connectionId, roomId);
    });

    ws.on('error', (error) => {
        console.error(`❌ Erreur WebSocket: ${participantId}`, error);
        cleanupConnection(connectionId, roomId);
    });

    // Envoyer les capacités RTP
    ws.send(JSON.stringify({
        action: 'rtp-capabilities',
        rtpCapabilities: room.router.rtpCapabilities
    }));
}

async function handleMediasoupMessage(connection, data) {
    const { action } = data;
    const { ws, router, transports, producers } = connection;

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

        default:
            console.warn('⚠️ Action inconnue:', action);
            ws.send(JSON.stringify({
                action: 'error',
                error: `Action inconnue: ${action}`
            }));
    }
}

async function handleCreateTransport(connection, data) {
    const { ws, router, transports, participantId } = connection;
    const { direction } = data;

    const transport = await router.createWebRtcTransport({
        listenIps: [
            {
                ip: '0.0.0.0',
                announcedIp: process.env.RENDER_EXTERNAL_URL ?
                    new URL(process.env.RENDER_EXTERNAL_URL).hostname : '127.0.0.1'
            }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000
    });

    transports.set(transport.id, transport);

    transport.on('dtlsstatechange', (dtlsState) => {
        if (dtlsState === 'closed') {
            transport.close();
        }
    });

    transport.on('close', () => {
        transports.delete(transport.id);
    });

    ws.send(JSON.stringify({
        action: 'transport-created',
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        direction: direction
    }));

    console.log(`✅ Transport créé: ${transport.id} pour ${participantId} (${direction})`);
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
    const { ws, transports, producers, router, participantId, roomId } = connection;
    const { transportId, kind, rtpParameters } = data;

    const transport = transports.get(transportId);
    if (!transport) {
        throw new Error(`Transport non trouvé: ${transportId}`);
    }

    const producer = await transport.produce({ kind, rtpParameters });
    producers.set(producer.id, producer);

    // Notifier tous les autres participants dans la room
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

    console.log(`✅ Producer créé: ${producer.id} (${kind}) pour ${participantId}`);

    producer.on('transportclose', () => {
        producer.close();
        producers.delete(producer.id);
    });
}

async function handleConsume(connection, data) {
    const { ws, transports, consumers, router, participantId } = connection;
    const { transportId, producerId, rtpCapabilities } = data;

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
        paused: true
    });

    consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
        consumer.close();
        consumers.delete(consumer.id);
    });

    ws.send(JSON.stringify({
        action: 'consumed',
        id: consumer.id,
        producerId: producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type
    }));

    console.log(`✅ Consumer créé: ${consumer.id} pour ${participantId}`);
}

async function handleResumeConsumer(connection, data) {
    const { consumers } = connection;
    const { consumerId } = data;

    const consumer = consumers.get(consumerId);
    if (!consumer) {
        throw new Error(`Consumer non trouvé: ${consumerId}`);
    }

    await consumer.resume();
    console.log(`✅ Consumer résumé: ${consumerId}`);
}

async function handleGetProducers(connection, data) {
    const { roomId, participantId, ws } = connection;
    const room = rooms.get(roomId);

    if (!room) {
        throw new Error('Room non trouvée');
    }

    // Récupérer tous les producers de la room (sauf ceux du participant actuel)
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
            if (conn.ws.readyState === 1) { // WebSocket.OPEN
                conn.ws.send(JSON.stringify(message));
            }
        }
    }
}

function cleanupConnection(connectionId, roomId) {
    const connection = connections.get(connectionId);
    if (connection) {
        // Fermer tous les transports
        for (const transport of connection.transports.values()) {
            transport.close();
        }

        // Notifier les autres participants
        broadcastToRoom(roomId, connection.participantId, {
            action: 'participant-left',
            participantId: connection.participantId
        });

        connections.delete(connectionId);
        console.log(`🧹 Connexion nettoyée: ${connectionId}`);
    }
}

// ==================== ROUTES API ====================

// Health check OBLIGATOIRE pour Render
app.get('/health', (req, res) => {
    const roomStats = Array.from(rooms.values()).map(room => ({
        roomId: room.roomId,
        participants: Array.from(connections.entries())
            .filter(([id, conn]) => conn.roomId === room.roomId).length,
        createdAt: room.createdAt
    }));

    res.json({
        status: 'ok',
        server: 'VisioCampus Mediasoup SFU - Render',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        rooms_count: rooms.size,
        connections_count: connections.size,
        room_stats: roomStats,
        worker: worker ? 'active' : 'inactive'
    });
});

// Route pour infos réseau
app.get('/network-info', (req, res) => {
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`;

    res.json({
        server_url: serverUrl,
        websocket_url: serverUrl.replace('http', 'ws') + '/ws',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Créer une room SFU
app.post('/rooms', async (req, res) => {
    try {
        const { room_id, max_participants = 50 } = req.body;

        if (!room_id) {
            return res.status(400).json({
                success: false,
                error: 'room_id requis'
            });
        }

        // Si la room existe déjà
        if (rooms.has(room_id)) {
            const room = rooms.get(room_id);
            return res.json({
                success: true,
                room_id,
                exists: true,
                participants_count: Array.from(connections.entries())
                    .filter(([id, conn]) => conn.roomId === room_id).length,
                max_participants: room.maxParticipants,
                rtp_capabilities: room.router.rtpCapabilities
            });
        }

        // Créer un nouveau router
        const router = await worker.createRouter({ mediaCodecs });

        rooms.set(room_id, {
            router,
            roomId: room_id,
            createdAt: new Date(),
            maxParticipants: max_participants
        });

        console.log(`✅ Room SFU créée: ${room_id} (max: ${max_participants} participants)`);

        res.json({
            success: true,
            room_id,
            exists: false,
            max_participants: max_participants,
            rtp_capabilities: router.rtpCapabilities
        });

    } catch (error) {
        console.error('❌ Erreur création room:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Générer token participant
app.post('/tokens', async (req, res) => {
    try {
        const { room_id, participant_id } = req.body;

        if (!room_id || !participant_id) {
            return res.status(400).json({
                success: false,
                error: 'room_id et participant_id requis'
            });
        }

        if (!rooms.has(room_id)) {
            return res.status(404).json({
                success: false,
                error: 'Room non trouvée'
            });
        }

        const room = rooms.get(room_id);
        const participantsCount = Array.from(connections.entries())
            .filter(([id, conn]) => conn.roomId === room_id).length;

        // Vérifier si la room n'est pas pleine
        if (participantsCount >= room.maxParticipants) {
            return res.status(429).json({
                success: false,
                error: 'Room pleine'
            });
        }

        const rtpCapabilities = room.router.rtpCapabilities;
        const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`;
        const websocketUrl = serverUrl.replace('http', 'ws') + '/ws';

        res.json({
            success: true,
            room_id,
            participant_id,
            rtp_capabilities: rtpCapabilities,
            server_url: websocketUrl,
            ice_servers: [
                {
                    urls: [
                        'stun:stun.l.google.com:19302',
                        'stun:stun1.l.google.com:19302',
                        'stun:stun2.l.google.com:19302'
                    ]
                }
            ],
            max_participants: room.maxParticipants,
            current_participants: participantsCount
        });

    } catch (error) {
        console.error('❌ Erreur génération token:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Obtenir les stats d'une room
app.get('/rooms/:room_id', (req, res) => {
    try {
        const { room_id } = req.params;

        if (!rooms.has(room_id)) {
            return res.status(404).json({
                success: false,
                error: 'Room non trouvée'
            });
        }

        const room = rooms.get(room_id);
        const roomConnections = Array.from(connections.entries())
            .filter(([id, conn]) => conn.roomId === room_id);

        const participants = roomConnections.map(([id, conn]) => ({
            id: conn.participantId,
            joinedAt: conn.joinedAt,
            transports: conn.transports.size,
            producers: conn.producers.size,
            consumers: conn.consumers.size
        }));

        res.json({
            success: true,
            room_id,
            created_at: room.createdAt,
            participants_count: participants.length,
            max_participants: room.maxParticipants,
            participants: participants
        });

    } catch (error) {
        console.error('❌ Erreur récupération room:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== GESTION DES WEBSOCKETS ====================
wss.on('connection', (ws, request) => {
    const clientIp = request.socket.remoteAddress;
    const url = new URL(request.url, `http://${request.headers.host}`);
    const roomId = url.searchParams.get('roomId');
    const participantId = url.searchParams.get('participantId');

    console.log(`✅ Nouvelle connexion WebSocket depuis: ${clientIp} - Room: ${roomId} - Participant: ${participantId}`);

    if (!roomId || !participantId) {
        ws.send(JSON.stringify({
            action: 'error',
            error: 'Paramètres roomId et participantId requis'
        }));
        ws.close();
        return;
    }

    if (!rooms.has(roomId)) {
        ws.send(JSON.stringify({
            action: 'error',
            error: 'Room non trouvée'
        }));
        ws.close();
        return;
    }

    handleMediasoupClient(ws, roomId, participantId);
});

// ==================== NETTOYAGE AUTOMATIQUE ====================
setInterval(() => {
    const now = new Date();
    const inactiveTime = 30 * 60 * 1000; // 30 minutes

    for (const [roomId, room] of rooms.entries()) {
        const roomConnections = Array.from(connections.entries())
            .filter(([id, conn]) => conn.roomId === roomId);

        if (now - room.createdAt > inactiveTime && roomConnections.length === 0) {
            // Fermer le router
            room.router.close();
            rooms.delete(roomId);
            console.log(`🧹 Room nettoyée: ${roomId}`);
        }
    }
}, 5 * 60 * 1000); // Vérification toutes les 5 minutes

// ==================== DÉMARRAGE DU SERVEUR ====================
async function startServer() {
    try {
        await createWorker();

        const PORT = process.env.PORT || 3001;
        const HOST = '0.0.0.0';

        server.listen(PORT, HOST, () => {
            console.log('='.repeat(60));
            console.log('🚀 VISIOCAMPUS MEDIASOUP SFU - RENDER');
            console.log('='.repeat(60));
            console.log(`📡 Port: ${PORT}`);
            console.log(`🖥️  Host: ${HOST}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`⚡ WebSocket: ws://0.0.0.0:${PORT}/ws`);
            console.log('='.repeat(60));
            console.log('✅ Routes disponibles:');
            console.log(`   ❤️  Health: /health`);
            console.log(`   🌐 Network: /network-info`);
            console.log(`   🏠 Rooms: POST /rooms`);
            console.log(`   🎫 Tokens: POST /tokens`);
            console.log('='.repeat(60));
            console.log(`✅ Serveur Mediasoup prêt sur Render`);
            console.log('='.repeat(60));
        });
    } catch (error) {
        console.error('❌ Erreur démarrage:', error);
        process.exit(1);
    }
}

// ==================== GESTION PROPRE DE L'ARRÊT ====================
const gracefulShutdown = async () => {
    console.log('\n🛑 Arrêt du serveur Mediasoup...');

    // Fermer toutes les connexions WebSocket
    for (const [id, connection] of connections.entries()) {
        connection.ws.close();
    }

    // Fermer le worker Mediasoup
    if (worker) {
        worker.close();
        console.log('✅ Worker Mediasoup fermé');
    }

    // Fermer le serveur HTTP
    server.close(() => {
        console.log('✅ Serveur HTTP fermé');
        process.exit(0);
    });

    // Force l'arrêt après 10 secondes
    setTimeout(() => {
        console.error('⚠️  Arrêt forcé après timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Démarrer le serveur
startServer();
