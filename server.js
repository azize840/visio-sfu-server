require('dotenv').config();

const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const dns = require('dns').promises;

const app = express();

// ==================== CONFIGURATION CORS ====================
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

// ==================== CONFIGURATION STUN/TURN ====================
const ICE_SERVERS = [
    {
        urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302'
        ]
    },
    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    },
    {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

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
let cachedPublicIp = null;

// ==================== FONCTION POUR OBTENIR L'IP PUBLIQUE - CORRIGÉE ====================
async function getPublicIp() {
    // Si déjà en cache, retourner immédiatement
    if (cachedPublicIp) {
        return cachedPublicIp;
    }

    try {
        // Méthode 1: Résoudre le hostname Render en IP
        if (process.env.RENDER_EXTERNAL_HOSTNAME) {
            console.log(`🔍 Résolution DNS de: ${process.env.RENDER_EXTERNAL_HOSTNAME}`);

            try {
                const addresses = await dns.resolve4(process.env.RENDER_EXTERNAL_HOSTNAME);
                if (addresses && addresses.length > 0) {
                    cachedPublicIp = addresses[0];
                    console.log(`✅ IP publique résolue: ${cachedPublicIp}`);
                    return cachedPublicIp;
                }
            } catch (dnsError) {
                console.warn(`⚠️ Erreur résolution DNS:`, dnsError.message);
            }
        }

        // Méthode 2: Utiliser un service externe (fallback)
        const https = require('https');

        const getIpFromService = (url) => {
            return new Promise((resolve, reject) => {
                https.get(url, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => {
                        try {
                            const ip = data.trim();
                            // Valider le format IP
                            if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
                                resolve(ip);
                            } else {
                                reject(new Error('Format IP invalide'));
                            }
                        } catch (e) {
                            reject(e);
                        }
                    });
                }).on('error', reject);
            });
        };

        console.log('🔍 Récupération IP via service externe...');

        // Essayer plusieurs services
        const services = [
            'https://api.ipify.org',
            'https://ifconfig.me/ip',
            'https://icanhazip.com'
        ];

        for (const service of services) {
            try {
                cachedPublicIp = await getIpFromService(service);
                console.log(`✅ IP publique obtenue: ${cachedPublicIp} (via ${service})`);
                return cachedPublicIp;
            } catch (err) {
                console.warn(`⚠️ Échec ${service}:`, err.message);
            }
        }

        // Si tout échoue, utiliser 0.0.0.0 (tous les interfaces)
        console.warn('⚠️ Impossible d\'obtenir l\'IP publique, utilisation de 0.0.0.0');
        cachedPublicIp = '0.0.0.0';
        return cachedPublicIp;

    } catch (error) {
        console.error('❌ Erreur récupération IP:', error);
        return '0.0.0.0';
    }
}

// ==================== CRÉATION DU WORKER MEDIASOUP ====================
async function createWorker() {
    worker = await mediasoup.createWorker({
        logLevel: 'debug', // Plus de logs pour diagnostiquer
        rtcMinPort: 10000,
        rtcMaxPort: 10100, // ✅ RÉDUIT pour Render (ports limités)
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

    // Envoyer les capacités RTP avec ICE servers
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

        default:
            console.warn('⚠️ Action inconnue:', action);
    }
}

// ✅ CRÉATION TRANSPORT AVEC IP PUBLIQUE RÉSOLUE
async function handleCreateTransport(connection, data) {
    const { ws, router, transports, participantId } = connection;
    const { direction } = data;

    // Obtenir l'IP publique résolue
    const announcedIp = await getPublicIp();

    console.log(`🌐 Création transport ${direction} avec announcedIp: ${announcedIp}`);

    const transport = await router.createWebRtcTransport({
        listenIps: [
            {
                ip: '0.0.0.0', // Écouter sur toutes les interfaces
                announcedIp: announcedIp // ✅ IP publique résolue
            }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1000000,
        minimumAvailableOutgoingBitrate: 600000,
        maxSctpMessageSize: 262144,
        iceConsentTimeout: 20,
        enableSctp: true
    });

    transports.set(transport.id, transport);

    // Logs détaillés pour diagnostic
    console.log(`📡 Transport ${transport.id} créé:`);
    console.log(`   - IP annoncée: ${announcedIp}`);
    console.log(`   - ICE candidates: ${transport.iceCandidates.length}`);
    transport.iceCandidates.forEach((candidate, i) => {
        console.log(`   - Candidate ${i + 1}: ${candidate.ip}:${candidate.port} (${candidate.protocol})`);
    });

    // Gestion des événements du transport
    transport.on('dtlsstatechange', (dtlsState) => {
        console.log(`🔐 DTLS ${transport.id}: ${dtlsState}`);
        if (dtlsState === 'closed' || dtlsState === 'failed') {
            console.error(`❌ Transport ${transport.id} DTLS ${dtlsState}`);
        }
    });

    transport.on('icestatechange', (iceState) => {
        console.log(`🧊 ICE ${transport.id}: ${iceState}`);
        if (iceState === 'disconnected') {
            console.warn(`⚠️ ICE disconnected pour ${transport.id}`);
        } else if (iceState === 'failed') {
            console.error(`❌ ICE failed pour ${transport.id}`);
        } else if (iceState === 'connected' || iceState === 'completed') {
            console.log(`✅ ICE ${iceState} pour ${transport.id}`);
        }
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

    console.log(`✅ Transport ${direction} créé: ${transport.id} pour ${participantId}`);
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

    const producer = await transport.produce({
        kind,
        rtpParameters
    });

    producers.set(producer.id, producer);

    // Notifier les autres participants
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

    console.log(`✅ Producer ${kind} créé: ${producer.id} pour ${participantId}`);

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

        console.log(`✅ Consumer créé: ${consumer.id} (${consumer.kind}) pour ${participantId}`);

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
        ws.send(JSON.stringify({
            action: 'error',
            error: error.message
        }));
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
    console.log(`✅ Consumer résumé: ${consumerId}`);

    ws.send(JSON.stringify({
        action: 'consumer-resumed',
        consumerId: consumerId
    }));
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
    let sentCount = 0;
    for (const [connId, conn] of connections.entries()) {
        if (conn.roomId === roomId && conn.participantId !== excludeParticipantId) {
            if (conn.ws.readyState === 1) {
                conn.ws.send(JSON.stringify(message));
                sentCount++;
            }
        }
    }
    if (sentCount > 0) {
        console.log(`📢 ${message.action} → ${sentCount} participants`);
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
        console.log(`🧹 Connexion nettoyée: ${connectionId}`);
    }
}

// ==================== ROUTES API ====================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'VisioCampus Mediasoup SFU',
        version: '3.1.0',
        timestamp: new Date().toISOString(),
        publicIp: cachedPublicIp,
        iceServers: ICE_SERVERS
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rooms: rooms.size,
        connections: connections.size,
        publicIp: cachedPublicIp,
        iceServers: ICE_SERVERS
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

    console.log(`✅ WebSocket: Room=${roomId}, Participant=${participantId}`);

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
        // ✅ IMPORTANT : Résoudre l'IP AVANT de créer le worker
        console.log('🔍 Résolution de l\'IP publique...');
        await getPublicIp();
        console.log(`✅ IP publique configurée: ${cachedPublicIp}`);

        await createWorker();

        const PORT = process.env.PORT || 3001;
        const HOST = '0.0.0.0';

        server.listen(PORT, HOST, () => {
            console.log('='.repeat(80));
            console.log('🚀 VISIOCAMPUS MEDIASOUP SFU - VERSION CORRIGÉE');
            console.log('='.repeat(80));
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌐 IP publique: ${cachedPublicIp}`);
            console.log(`🎯 STUN: ${ICE_SERVERS[0].urls.length} serveurs`);
            console.log(`🎯 TURN: openrelay.metered.ca`);
            console.log('='.repeat(80));
        });
    } catch (error) {
        console.error('❌ Erreur démarrage:', error);
        process.exit(1);
    }
}

// ==================== SHUTDOWN ====================
const gracefulShutdown = async () => {
    console.log('\n🛑 Arrêt du serveur...');

    for (const [id, connection] of connections.entries()) {
        try {
            connection.ws.close();
        } catch (error) {}
    }

    if (worker) worker.close();

    server.close(() => {
        console.log('✅ Serveur fermé');
        process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Démarrer
startServer();
