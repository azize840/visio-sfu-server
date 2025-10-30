// server.js - Serveur Mediasoup SFU pour VisioCampus - VERSION RENDER
require('dotenv').config();

const mediasoup = require('mediasoup');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const app = express();

// ==================== CONFIGURATION CORS POUR RENDER ====================
app.use(cors({
    origin: function (origin, callback) {
        // Domaines autorisés en production
        const allowedOrigins = [
            'https://votre-app-frontend.onrender.com', // ← REMPLACEZ PAR VOTRE URL RENDER
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:8000',
            'http://127.0.0.1:8000',
            'http://localhost:5173',
            'http://127.0.0.1:5173'
        ];

        // En développement, tout autoriser
        if (process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }

        // En production, vérifier les origines
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn('🚨 CORS bloqué pour:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
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

// ==================== CRÉATION DU WORKER MEDIASOUP ====================
async function createWorker() {
    worker = await mediasoup.createWorker({
        logLevel: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
        rtcMinPort: 10000, // ← PORT MIN POUR RENDER
        rtcMaxPort: 59999, // ← PORT MAX POUR RENDER
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
    });

    console.log('✅ Worker Mediasoup créé');

    worker.on('died', () => {
        console.error('❌ Mediasoup worker died - Redémarrage nécessaire');
        process.exit(1);
    });

    return worker;
}

// ==================== ROUTES API ====================

// Health check OBLIGATOIRE pour Render
app.get('/health', (req, res) => {
    const roomStats = Array.from(rooms.values()).map(room => ({
        participants: room.participants.size,
        createdAt: room.createdAt
    }));

    res.json({
        status: 'ok',
        server: 'VisioCampus Mediasoup SFU - Render',
        environment: process.env.NODE_ENV || 'development',
        timestamp: new Date().toISOString(),
        rooms_count: rooms.size,
        room_stats: roomStats,
        worker: worker ? 'active' : 'inactive'
    });
});

// Route pour infos réseau (ADAPTÉ POUR RENDER)
app.get('/network-info', (req, res) => {
    const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3001}`;

    res.json({
        server_url: serverUrl,
        websocket_url: serverUrl.replace('http', 'ws') + '/ws',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// Créer une room SFU (GARDÉ TEL QUEL)
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
                participants_count: room.participants.size,
                max_participants: room.maxParticipants,
                rtp_capabilities: room.router.rtpCapabilities
            });
        }

        // Créer un nouveau router
        const router = await worker.createRouter({ mediaCodecs });

        rooms.set(room_id, {
            router,
            participants: new Map(),
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

// Générer token participant (GARDÉ TEL QUEL)
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

        // Vérifier si la room n'est pas pleine
        if (room.participants.size >= room.maxParticipants) {
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
            current_participants: room.participants.size
        });

    } catch (error) {
        console.error('❌ Erreur génération token:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Obtenir les stats d'une room (GARDÉ TEL QUEL)
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
        const participants = Array.from(room.participants.values()).map(p => ({
            id: p.id,
            joinedAt: p.joinedAt,
            transports: p.transports ? p.transports.size : 0
        }));

        res.json({
            success: true,
            room_id,
            created_at: room.createdAt,
            participants_count: room.participants.size,
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

    console.log(`✅ Nouvelle connexion WebSocket depuis: ${clientIp}`);

    // Message de bienvenue
    ws.send(JSON.stringify({
        action: 'connected',
        message: 'Connexion SFU établie',
        server: 'VisioCampus Mediasoup - Render',
        timestamp: new Date().toISOString()
    }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Message WebSocket:', data.action);

            // Accusé de réception
            ws.send(JSON.stringify({
                action: 'ack',
                original_action: data.action,
                received: true,
                timestamp: new Date().toISOString()
            }));

        } catch (error) {
            console.error('❌ Erreur WebSocket:', error);
            ws.send(JSON.stringify({
                action: 'error',
                error: error.message
            }));
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 Connexion WebSocket fermée: ${code} - ${reason}`);
    });

    ws.on('error', (error) => {
        console.error('❌ Erreur WebSocket:', error);
    });
});

// ==================== NETTOYAGE AUTOMATIQUE DES ROOMS ====================
setInterval(() => {
    const now = new Date();
    const inactiveTime = 30 * 60 * 1000; // 30 minutes

    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt > inactiveTime && room.participants.size === 0) {
            rooms.delete(roomId);
            console.log(`🧹 Room nettoyée: ${roomId}`);
        }
    }
}, 5 * 60 * 1000); // Vérification toutes les 5 minutes

// ==================== DÉMARRAGE DU SERVEUR (ADAPTÉ POUR RENDER) ====================
async function startServer() {
    try {
        await createWorker();

        const PORT = process.env.PORT || 3001; // ← PORT DYNAMIQUE RENDER
        const HOST = '0.0.0.0'; // ← OBLIGATOIRE POUR RENDER

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
