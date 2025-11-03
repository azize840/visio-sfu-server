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
        router: room.router,
        joinedAt: new Date()
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
                announcedIp: process.env.RENDER_EXTERNAL_HOSTNAME || '127.0.0.1'
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

    // ✅ CORRECTION : Surveiller l'état du producer
    producer.on('trackended', () => {
        console.log(`🔚 Track terminée pour producer: ${producer.id}`);
        broadcastToRoom(roomId, participantId, {
            action: 'producer-closed',
            participantId: participantId,
            producerId: producer.id
        });
    });
}

// ✅ CORRECTION COMPLÈTE : Gestion de la consommation avec tracks
async function handleConsume(connection, data) {
    const { ws, transports, consumers, router, participantId } = connection;
    const { transportId, producerId, rtpCapabilities } = data;

    if (!router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume - RTP capabilities incompatibles');
    }

    const transport = transports.get(transportId);
    if (!transport) {
        throw new Error(`Transport non trouvé: ${transportId}`);
    }

    // ✅ CORRECTION : Créer le consumer sans le mettre en pause
    const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false // ⚠️ IMPORTANT : Ne pas mettre en pause pour recevoir les données
    });

    consumers.set(consumer.id, consumer);

    // ✅ CORRECTION : Envoyer les informations de track au client
    const trackInfo = {
        id: consumer.track.id,
        kind: consumer.track.kind,
        enabled: consumer.track.enabled,
        readyState: consumer.track.readyState,
        muted: consumer.track.muted,
        label: consumer.track.label || `remote-${consumer.kind}`
    };

    ws.send(JSON.stringify({
        action: 'consumed',
        id: consumer.id,
        producerId: producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        track: trackInfo, // ✅ ENVOYER LES INFOS DE TRACK
        participantId: this.getParticipantIdFromProducer(producerId) // Ajouter l'ID du participant
    }));

    console.log(`✅ Consumer créé: ${consumer.id} pour ${participantId}, track: ${trackInfo.id}`);

    // ✅ CORRECTION : Gestion des événements de la track
    consumer.track.onmute = () => {
        console.log(`🔇 Track ${consumer.track.id} muted`);
        ws.send(JSON.stringify({
            action: 'track-muted',
            consumerId: consumer.id,
            kind: consumer.kind
        }));
    };

    consumer.track.onunmute = () => {
        console.log(`🔊 Track ${consumer.track.id} unmuted`);
        ws.send(JSON.stringify({
            action: 'track-unmuted',
            consumerId: consumer.id,
            kind: consumer.kind
        }));
    };

    consumer.track.onended = () => {
        console.log(`🔚 Track ${consumer.track.id} ended`);
        ws.send(JSON.stringify({
            action: 'track-ended',
            consumerId: consumer.id,
            kind: consumer.kind
        }));
    };

    consumer.on('transportclose', () => {
        console.log(`🚗 Transport fermé pour consumer: ${consumer.id}`);
        consumer.close();
        consumers.delete(consumer.id);
    });

    consumer.on('producerclose', () => {
        console.log(`🎬 Producer fermé pour consumer: ${consumer.id}`);
        ws.send(JSON.stringify({
            action: 'producer-closed',
            producerId: producerId,
            consumerId: consumer.id
        }));
        consumer.close();
        consumers.delete(consumer.id);
    });

    // ✅ CORRECTION : Résumer immédiatement le consumer
    try {
        if (consumer.paused) {
            await consumer.resume();
            console.log(`▶️ Consumer résumé: ${consumer.id}`);
        }
    } catch (error) {
        console.error(`❌ Erreur résumption consumer ${consumer.id}:`, error.message);
    }
}

// ✅ NOUVELLE MÉTHODE : Trouver le participantId à partir du producerId
function getParticipantIdFromProducer(producerId) {
    for (const [connectionId, connection] of connections.entries()) {
        if (connection.producers.has(producerId)) {
            return connection.participantId;
        }
    }
    return null;
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

    // Notifier le client
    connection.ws.send(JSON.stringify({
        action: 'consumer-resumed',
        consumerId: consumerId
    }));
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
                    kind: producer.kind,
                    participantName: `User-${conn.participantId}` // Peut être amélioré
                });
            }
        }
    }

    ws.send(JSON.stringify({
        action: 'producers',
        producers: allProducers
    }));

    console.log(`📊 ${allProducers.length} producers envoyés à ${participantId}`);
}

function broadcastToRoom(roomId, excludeParticipantId, message) {
    let sentCount = 0;
    for (const [connId, conn] of connections.entries()) {
        if (conn.roomId === roomId && conn.participantId !== excludeParticipantId) {
            if (conn.ws.readyState === 1) { // WebSocket.OPEN
                conn.ws.send(JSON.stringify(message));
                sentCount++;
            }
        }
    }
    console.log(`📢 Message ${message.action} diffusé à ${sentCount} participants`);
}

function cleanupConnection(connectionId, roomId) {
    const connection = connections.get(connectionId);
    if (connection) {
        const { participantId } = connection;

        // Fermer tous les transports
        for (const transport of connection.transports.values()) {
            try {
                transport.close();
            } catch (error) {
                console.error(`❌ Erreur fermeture transport: ${error.message}`);
            }
        }

        // Notifier les autres participants
        broadcastToRoom(roomId, participantId, {
            action: 'participant-left',
            participantId: participantId,
            reason: 'disconnected'
        });

        connections.delete(connectionId);
        console.log(`🧹 Connexion nettoyée: ${connectionId}`);
    }
}

// ==================== ROUTES API ====================

// Route racine OBLIGATOIRE pour Render
app.get('/', (req, res) => {
    res.json({
        status: 'SFU Server Running',
        service: 'VisioCampus Mediasoup SFU - CORRIGÉ',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        version: '2.0.0',
        features: ['audio', 'video', 'real-time', 'tracks-fixed'],
        routes: {
            health: '/health',
            network: '/network-info',
            create_room: 'POST /rooms',
            create_token: 'POST /tokens',
            websocket: '/ws'
        }
    });
});

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
        server: 'VisioCampus Mediasoup SFU - Render (CORRIGÉ)',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        rooms_count: rooms.size,
        connections_count: connections.size,
        room_stats: roomStats,
        worker: worker ? 'active' : 'inactive',
        features: {
            tracks: 'enabled',
            audio: 'enabled',
            video: 'enabled',
            websocket: 'enabled'
        }
    });
});

// Route pour infos réseau
app.get('/network-info', (req, res) => {
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`;

    res.json({
        server_url: serverUrl,
        websocket_url: serverUrl.replace('http', 'ws') + '/ws',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        ice_servers: [
            {
                urls: [
                    'stun:stun.l.google.com:19302',
                    'stun:stun1.l.google.com:19302',
                    'stun:stun2.l.google.com:19302'
                ]
            }
        ]
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
            const participantsCount = Array.from(connections.entries())
                .filter(([id, conn]) => conn.roomId === room_id).length;

            return res.json({
                success: true,
                room_id,
                exists: true,
                participants_count: participantsCount,
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
    let cleanedRooms = 0;
    let cleanedConnections = 0;

    // Nettoyer les connexions orphelines
    for (const [connectionId, connection] of connections.entries()) {
        if (now - connection.joinedAt > inactiveTime) {
            cleanupConnection(connectionId, connection.roomId);
            cleanedConnections++;
        }
    }

    // Nettoyer les rooms vides
    for (const [roomId, room] of rooms.entries()) {
        const roomConnections = Array.from(connections.entries())
            .filter(([id, conn]) => conn.roomId === roomId);

        if (roomConnections.length === 0 && (now - room.createdAt > inactiveTime)) {
            try {
                room.router.close();
                rooms.delete(roomId);
                cleanedRooms++;
                console.log(`🧹 Room nettoyée: ${roomId}`);
            } catch (error) {
                console.error(`❌ Erreur nettoyage room ${roomId}:`, error.message);
            }
        }
    }

    if (cleanedRooms > 0 || cleanedConnections > 0) {
        console.log(`🧹 Nettoyage automatique: ${cleanedRooms} rooms, ${cleanedConnections} connexions`);
    }
}, 5 * 60 * 1000); // Vérification toutes les 5 minutes

// ==================== DÉMARRAGE DU SERVEUR ====================
async function startServer() {
    try {
        await createWorker();

        const PORT = process.env.PORT || 3001;
        const HOST = '0.0.0.0';

        server.listen(PORT, HOST, () => {
            console.log('='.repeat(80));
            console.log('🚀 VISIOCAMPUS MEDIASOUP SFU - RENDER (CORRIGÉ)');
            console.log('='.repeat(80));
            console.log(`📡 Port: ${PORT}`);
            console.log(`🖥️  Host: ${HOST}`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`⚡ WebSocket: ws://${HOST}:${PORT}/ws`);
            console.log('='.repeat(80));
            console.log('✅ Routes disponibles:');
            console.log(`   🏠 Root: /`);
            console.log(`   ❤️  Health: /health`);
            console.log(`   🌐 Network: /network-info`);
            console.log(`   🏠 Rooms: POST /rooms`);
            console.log(`   🎫 Tokens: POST /tokens`);
            console.log('='.repeat(80));
            console.log('🎯 CORRECTIONS APPLIQUÉES:');
            console.log(`   ✅ Tracks envoyées aux clients`);
            console.log(`   ✅ Consumers non mis en pause`);
            console.log(`   ✅ Gestion des événements tracks`);
            console.log(`   ✅ Résumption automatique`);
            console.log('='.repeat(80));
            console.log(`✅ Serveur Mediasoup PRÊT avec gestion des tracks`);
            console.log(`🔗 URL: https://visio-sfu-server-6.onrender.com`);
            console.log('='.repeat(80));
        });
    } catch (error) {
        console.error('❌ Erreur démarrage:', error);
        process.exit(1);
    }
}

// ==================== GESTION PROPRE DE L'ARRÊT ====================
const gracefulShutdown = async () => {
    console.log('\n🛑 Arrêt du serveur Mediasoup...');

    // Notifier tous les clients
    for (const [id, connection] of connections.entries()) {
        try {
            connection.ws.send(JSON.stringify({
                action: 'server-shutdown',
                message: 'Le serveur va redémarrer',
                timestamp: Date.now()
            }));
            connection.ws.close();
        } catch (error) {
            // Ignorer les erreurs de fermeture
        }
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

// Gestion des erreurs globales
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejetée:', reason);
});

// Démarrer le serveur
startServer();
